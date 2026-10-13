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
// MAKO_SANDBOX_RESULT_FILE (where the result goes; stdout without it).
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedSidecar } from "@hatchet-dev/typescript-sdk/v1/embedded";
import { prepare, startWorker, typecheck } from "./build.mjs";

// The engine the sidecar runs, pinned: the one the sandbox image carries
// (api/src/apps/e2b-template.ts), so a box never fetches another.
const ENGINE_VERSION = "v0.110.5";
const ENGINE_START_ATTEMPTS = 4;
const RUN_TIMEOUT_MS = 300_000;
const POLL_MS = 500;
const LOG_LINES_PER_STEP = 20;
const MAX_TEXT_CHARS = 4000;

const [name, encodedInput] = process.argv.slice(2);
const input = JSON.parse(
  Buffer.from(encodedInput ?? "", "base64").toString() || "{}",
);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waiting for the engine does not by itself keep Node alive (it exits with
// code 13 on Node 20.9, the sandbox's); this does, until finish() exits.
setInterval(() => {}, 60_000);
/** A step's output can be any size; Mako shows the start of it. */
const clip = value => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text?.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : value;
};

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

  // The last run's Postgres can hold the data folder a moment after its
  // engine stopped: try again before giving up.
  for (let attempt = 1; !engine; attempt++) {
    engine = await startEmbeddedSidecar({ version: ENGINE_VERSION }).catch(
      err => {
        if (attempt === ENGINE_START_ATTEMPTS) throw err;
      },
    );
    if (!engine) await sleep(3_000);
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
      `/api/v1/stable/tasks/${task.metadata.id}/logs`,
    )
      .then(list =>
        (list.rows ?? [])
          .slice(-LOG_LINES_PER_STEP)
          .map(line => ({ message: clip(line.message) })),
      )
      .catch(() => []);
  }
  detail.run.output = clip(detail.run.output);
  await finish({ detail: { run: detail.run, tasks: detail.tasks }, logs });
} catch (err) {
  await finish({ buildError: err?.message ?? String(err) });
}
