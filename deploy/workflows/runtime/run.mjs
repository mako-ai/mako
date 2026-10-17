// A sandbox run: one workflow of a checkout, as it is on disk, run once on a
// Hatchet engine of its own (embedded mode: a local engine with a bundled
// Postgres, no token, no network). Started by Mako in a person's sandbox
// (api/src/workflows/sandbox.ts); writes what Hatchet recorded of the run and
// exits. Schedules and event triggers are off: the workflow runs because it
// was started.
//
//   node run.mjs <workflow> <base64 of the JSON input>
//
// Env: WORKFLOWS_ROOT (the checkout), MAKO_URL, MAKO_API_KEY (for lib/mako),
// MAKO_SANDBOX_RESULT_FILE (where the result goes; stdout without it),
// MAKO_SANDBOX_RUN_TIMEOUT_MS (how long the workflow may run),
// MAKO_SANDBOX_ENGINE_DIR (where engines keep their Postgres, one folder per
// run), MAKO_SANDBOX_RUN_ID (this run's folder name there).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedSidecar } from "@hatchet-dev/typescript-sdk/v1/embedded";
import { prepare, startWorker, typecheck } from "./build.mjs";

// The engine the sidecar runs, pinned: the one the sandbox image carries
// (api/src/apps/e2b-template.ts), so a box never fetches another.
const ENGINE_VERSION = "v0.110.5";
const ENGINE_START_ATTEMPTS = 3;
const RUN_TIMEOUT_MS =
  Number(process.env.MAKO_SANDBOX_RUN_TIMEOUT_MS) || 300_000;
const POLL_MS = 500;
// Mako keeps each text up to a megabyte and every log line; it shows a
// summary unless asked for all of it.
const MAX_TEXT_CHARS = 1_000_000;
const MAX_LOG_CHARS_PER_STEP = 1_000_000;
const MAX_LOG_LINES = 10_000;
// Each run's engine keeps its Postgres in a folder of its own here, so no
// run ever starts on what another left: an engine and Postgres that a killed
// run left running hold only their own folder.
const ENGINE_DIR =
  process.env.MAKO_SANDBOX_ENGINE_DIR ||
  join(homedir(), ".mako-workflow-engine");
const RUN_DIR = join(
  ENGINE_DIR,
  (process.env.MAKO_SANDBOX_RUN_ID || `run-${process.pid}`).replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  ),
);

const [name, encodedInput] = process.argv.slice(2);
const input = JSON.parse(
  Buffer.from(encodedInput ?? "", "base64").toString() || "{}",
);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waiting for the engine does not by itself keep Node alive (it exits with
// code 13 on Node 20.9, the sandbox's); this does, until finish() exits.
setInterval(() => {}, 60_000);
/** A step's output can be any size; Mako keeps the first megabyte. */
const clip = value => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text?.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}… (${text.length} chars)`
    : value;
};
/** A step's log lines, the last ones when there are more than Mako keeps. */
function keepLines(rows) {
  // Hatchet lists them in no order; by time, oldest first.
  // Parsed: Hatchet writes fractions of a second at varying lengths.
  const at = row => Date.parse(String(row.createdAt ?? "")) || 0;
  const sorted = [...rows].sort((a, b) => at(a) - at(b));
  const kept = [];
  let chars = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const message = clip(sorted[i].message);
    chars += String(message ?? "").length;
    if (chars > MAX_LOG_CHARS_PER_STEP) break;
    kept.unshift({ createdAt: sorted[i].createdAt, message });
  }
  return kept;
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stop what earlier runs left behind and delete their folders. A run whose
 * exec was killed (a timeout) can leave its engine, and the engine's
 * Postgres outlives it. Both name their run's folder in their command line;
 * Postgres by its real path (/private/var/… for /var/…). One run at a time
 * per box (Mako's lock), so every other folder is a leftover.
 */
async function stopLeftovers() {
  const old = readdirSync(ENGINE_DIR)
    .map(entry => join(ENGINE_DIR, entry))
    .filter(dir => dir !== RUN_DIR);
  if (!old.length) return;
  const named = old.flatMap(dir => [`${dir}/`, `${realpathSync(dir)}/`]);
  let pids = [];
  try {
    pids = execFileSync("ps", ["-A", "-o", "pid=,command="])
      .toString()
      .split("\n")
      .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .filter(
        ([, , command]) =>
          /hatchet-embedded-sidecar|postgres/.test(command) &&
          named.some(dir => command.includes(dir)),
      )
      .map(([, pid]) => Number(pid));
  } catch {
    // No ps: nothing to stop, only folders to delete.
  }
  if (pids.length) {
    console.error(
      `Stopping what an earlier run left running: ${pids.join(", ")}`,
    );
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(250);
  }
  for (const dir of old) rmSync(dir, { recursive: true, force: true });
}

let root;
let worker;
let engine;

async function finish(result) {
  worker?.kill("SIGKILL");
  if (root) rmSync(root, { recursive: true, force: true });
  const json = JSON.stringify(result);
  if (process.env.MAKO_SANDBOX_RESULT_FILE) {
    writeFileSync(process.env.MAKO_SANDBOX_RESULT_FILE, json);
  } else console.log(json);
  // Stop the engine and its Postgres, then its folder goes.
  await engine?.stop().catch(() => undefined);
  rmSync(RUN_DIR, { recursive: true, force: true });
  process.exit(0);
}

try {
  // A copy, not the checkout: the packages link and the generated files stay
  // out of the repository.
  root = mkdtempSync(join(tmpdir(), "mako-sandbox-"));
  cpSync(
    join(process.env.WORKFLOWS_ROOT, "workflows"),
    join(root, "workflows"),
    {
      recursive: true,
    },
  );
  prepare(root);
  const errors = typecheck(root);
  if (errors) await finish({ buildError: errors });

  mkdirSync(RUN_DIR, { recursive: true });
  await stopLeftovers();
  const engineStart = Date.now();
  for (let attempt = 1; !engine; attempt++) {
    engine = await startEmbeddedSidecar({
      version: ENGINE_VERSION,
      postgresDataDir: join(RUN_DIR, "postgres"),
    }).catch(err => {
      if (attempt === ENGINE_START_ATTEMPTS) throw err;
    });
    if (!engine) await sleep(3_000);
  }
  console.error(`Engine ready in ${Date.now() - engineStart} ms`);
  const api = async (path, init) => {
    const res = await fetch(`${engine.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${engine.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };

  // The same worker production runs, pointed at the local engine.
  worker = await startWorker(root, {
    GIT_SHA: "sandbox",
    SANDBOX: "1",
    HATCHET_CLIENT_TOKEN: engine.token,
    HATCHET_CLIENT_HOST_PORT: engine.grpcAddress,
    HATCHET_CLIENT_API_URL: engine.apiUrl,
    HATCHET_CLIENT_TLS_STRATEGY: "none",
  });
  const started = await api(
    `/api/v1/stable/tenants/${engine.tenantId}/workflow-runs/trigger`,
    {
      method: "POST",
      body: JSON.stringify({
        workflowName: name,
        input,
        additionalMetadata: { trigger: "sandbox" },
      }),
    },
  ).catch(() => {
    throw new Error(
      `"${name}" is not a workflow in this checkout: there is no workflows/${name}/workflow.ts.`,
    );
  });

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let detail;
  for (;;) {
    detail = await api(
      `/api/v1/stable/workflow-runs/${started.run.metadata.id}`,
    );
    if (!["QUEUED", "RUNNING"].includes(detail.run?.status)) break;
    if (Date.now() > deadline) {
      detail.run.errorMessage = `Still running after ${RUN_TIMEOUT_MS / 1000}s; a sandbox run ends here.`;
      break;
    }
    await sleep(POLL_MS);
  }
  const logs = {};
  for (const task of detail.tasks ?? []) {
    task.output = clip(task.output);
    task.errorMessage = clip(task.errorMessage);
    logs[task.metadata.id] = await api(
      `/api/v1/stable/tasks/${task.metadata.id}/logs?limit=${MAX_LOG_LINES}`,
    )
      .then(list => keepLines(list.rows ?? []))
      .catch(() => []);
  }
  detail.run.output = clip(detail.run.output);
  await finish({ detail: { run: detail.run, tasks: detail.tasks }, logs });
} catch (err) {
  await finish({ buildError: err?.message ?? String(err) });
}
