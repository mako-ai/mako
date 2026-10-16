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
// MAKO_SANDBOX_ENGINE_DIR (the engine's Postgres; one per box).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const ENGINE_START_ATTEMPTS = 6;
const RUN_TIMEOUT_MS =
  Number(process.env.MAKO_SANDBOX_RUN_TIMEOUT_MS) || 300_000;
const POLL_MS = 500;
// Mako keeps each text up to a megabyte and every log line; it shows a
// summary unless asked for all of it.
const MAX_TEXT_CHARS = 1_000_000;
const MAX_LOG_CHARS_PER_STEP = 1_000_000;
const MAX_LOG_LINES = 10_000;
// The engine's Postgres lives here, and nothing else does: whatever runs
// with this path in its command line is this box's engine.
const ENGINE_DIR =
  process.env.MAKO_SANDBOX_ENGINE_DIR ||
  join(homedir(), ".mako-workflow-engine");
const PIDFILE = join(ENGINE_DIR, "run.pid");

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
  const sorted = [...rows].sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );
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
 * Stop what an earlier run left behind: a run whose caller gave up (or whose
 * exec was killed) can leave its run.mjs, its engine, and the engine's
 * Postgres, which outlives the engine and holds the data folder, so the next
 * engine exits before it is ready. The earlier run.mjs is named by the
 * pidfile; the engine and its Postgres by ENGINE_DIR in their command line.
 * Then the engine's data starts over: an engine that was killed stays
 * registered in it, and the next one waits a minute for it to expire. The
 * data is only this box's last runs, which Mako keeps.
 */
async function stopLeftovers() {
  let list;
  try {
    list = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="])
      .toString()
      .split("\n")
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, ppid, command]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        command,
      }));
  } catch {
    return;
  }
  const targets = new Set();
  let previous;
  try {
    previous = Number(readFileSync(PIDFILE, "utf8"));
  } catch {
    // No earlier run.
  }
  const prior = list.find(
    p =>
      p.pid === previous &&
      p.pid !== process.pid &&
      p.command.includes("run.mjs"),
  );
  if (prior) {
    const queue = [prior.pid];
    while (queue.length) {
      const pid = queue.pop();
      targets.add(pid);
      for (const child of list) if (child.ppid === pid) queue.push(child.pid);
    }
  }
  // This run and the shell that started it name ENGINE_DIR too (in its
  // environment, on the command line): never those.
  const own = new Set();
  for (let pid = process.pid; pid > 1 && !own.has(pid);) {
    own.add(pid);
    pid = list.find(p => p.pid === pid)?.ppid ?? 0;
  }
  // Postgres names the folder by its real path (/private/var/… for /var/…).
  const dirs = [ENGINE_DIR, realpathSync(ENGINE_DIR)];
  for (const p of list) {
    const engine =
      dirs.some(dir => p.command.includes(dir)) &&
      /hatchet-embedded-sidecar|postgres/.test(p.command);
    if (engine) targets.add(p.pid);
  }
  for (const pid of own) targets.delete(pid);
  if (!targets.size) return;
  console.error(
    `Stopping what an earlier run left running: ${[...targets].join(", ")}`,
  );
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (let i = 0; i < 20 && [...targets].some(alive); i++) await sleep(500);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await sleep(500);
  rmSync(join(ENGINE_DIR, "postgres"), { recursive: true, force: true });
}

let root;
let worker;
let engine;

async function finish(result) {
  worker?.kill("SIGKILL");
  try {
    if (readFileSync(PIDFILE, "utf8") === String(process.pid)) rmSync(PIDFILE);
  } catch {
    // Not ours, or gone.
  }
  if (root) rmSync(root, { recursive: true, force: true });
  const json = JSON.stringify(result);
  if (process.env.MAKO_SANDBOX_RESULT_FILE) {
    writeFileSync(process.env.MAKO_SANDBOX_RESULT_FILE, json);
  } else console.log(json);
  // Stop the engine before leaving: the next run starts its own on the same
  // data folder, and two cannot hold it.
  await engine?.stop().catch(() => undefined);
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

  mkdirSync(ENGINE_DIR, { recursive: true });
  await stopLeftovers();
  writeFileSync(PIDFILE, String(process.pid));
  // The last run's Postgres can hold the data folder a moment after its
  // engine stopped: try again before giving up.
  for (let attempt = 1; !engine; attempt++) {
    engine = await startEmbeddedSidecar({
      version: ENGINE_VERSION,
      postgresDataDir: join(ENGINE_DIR, "postgres"),
    }).catch(async err => {
      if (attempt === ENGINE_START_ATTEMPTS) throw err;
      await stopLeftovers();
    });
    if (!engine) await sleep(5_000);
  }
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
