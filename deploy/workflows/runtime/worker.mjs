// The dispatcher: one Hatchet worker for the workflows under WORKFLOWS_ROOT,
// started by entrypoint.mjs. It holds the worker key and the Hatchet token,
// and runs no workflow code: a workflow is described by a step program
// (step.mjs describe) and each of its steps runs in a step program of its
// own, as the workflow's own user, with a pass for that step from Mako
// (api/src/workflows/pass.ts) instead of the key. Workflows that share this
// pod can then not act as each other: a step has no key and no token to
// borrow, and another workflow's user cannot read its pass.
//
// A workflow is `workflows/<name>/workflow.ts` whose default export is the
// workflow named `<name>`. It keeps its schedule and event triggers only when
// it is active (WORKFLOWS_ACTIVE, comma-separated names).
//
// Env: WORKFLOWS_ROOT, GIT_SHA, HATCHET_CLIENT_TOKEN, WORKFLOWS_ACTIVE,
// MAKO_URL, MAKO_API_KEY.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HatchetClient,
  NonRetryableError,
} from "@hatchet-dev/typescript-sdk/v1";

const READY_TIMEOUT_MS = 45_000;
const DESCRIBE_TIMEOUT_MS = 60_000;
// A step program stays for the workflow's next step this long: a workflow
// that runs every few seconds keeps one, a daily one does not.
const IDLE_MS = 60_000;
const STEP = fileURLToPath(new URL("./step.mjs", import.meta.url));
const root = process.env.WORKFLOWS_ROOT;
const active = new Set((process.env.WORKFLOWS_ACTIVE ?? "").split(","));
const makoUrl = (process.env.MAKO_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const workerKey = process.env.MAKO_API_KEY ?? "";

// Each workflow's steps run as a user of their own when this process can
// switch users (root, in the pod's gVisor sandbox); describing runs as one
// more. Elsewhere (a laptop) they run as this user, still without key or
// token.
const canSwitchUsers =
  typeof process.getuid === "function" && process.getuid() === 0;
//
// A workflow's user comes from its name, so it is the same in every deploy:
// a user, and whatever it left behind, never passes to another workflow.
const FIRST_UID = 100_000;
const UID_RANGE = 1_000_000;
const DESCRIBE_UID = FIRST_UID - 1;
// Homes are this worker's own (WORKER_RUN, from entrypoint.mjs), removed
// when it stops: nothing a step left survives into the next deploy.
const HOMES = join("/tmp/wf", process.env.WORKER_RUN || "local");

/** Users for `names`, from each name; a clash (rare) takes the next free one. */
function usersFor(names) {
  const users = new Map();
  const taken = new Set([DESCRIBE_UID]);
  for (const name of names) {
    let uid =
      FIRST_UID +
      (createHash("sha256").update(name).digest().readUInt32BE(0) % UID_RANGE);
    while (taken.has(uid))
      uid = FIRST_UID + ((uid - FIRST_UID + 1) % UID_RANGE);
    taken.add(uid);
    users.set(name, uid);
  }
  return users;
}

if (canSwitchUsers) {
  // Step users may pass through /tmp to their homes, not list it or write
  // there: no file is left for another workflow to find.
  chmodSync("/tmp", 0o711);
  mkdirSync("/tmp/wf", { recursive: true, mode: 0o711 });
  chmodSync("/tmp/wf", 0o711);
}

/** A step program's environment: no key, no token, a home of its own. */
function stepEnv(uid) {
  // Each user may enter its own home and no other's.
  mkdirSync(HOMES, { recursive: true, mode: 0o711 });
  if (canSwitchUsers) chmodSync(HOMES, 0o711);
  const home = join(HOMES, canSwitchUsers ? String(uid) : "steps");
  mkdirSync(home, { mode: 0o700, recursive: true });
  if (canSwitchUsers) chownSync(home, uid, uid);
  return {
    PATH: process.env.PATH,
    ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
    WORKFLOWS_ROOT: root,
    MAKO_URL: makoUrl,
    GIT_SHA: process.env.GIT_SHA ?? "",
    HOME: home,
    TMPDIR: home,
  };
}

function startStepProgram(args, uid) {
  return fork(STEP, args, {
    env: stepEnv(uid),
    stdio: ["ignore", "inherit", "pipe", "ipc"],
    ...(canSwitchUsers ? { uid, gid: uid } : {}),
  });
}

/** What every workflow declares, from a step program: no code runs here. */
function describeWorkflows() {
  return new Promise((resolve, reject) => {
    const child = startStepProgram(["describe"], DESCRIBE_UID);
    let stderr = "";
    child.stderr.on("data", chunk => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), DESCRIBE_TIMEOUT_MS);
    child.once("message", message => {
      clearTimeout(timer);
      if (message?.type === "described") resolve(message.definitions);
      else
        reject(new Error(message?.error ?? "Describing the workflows failed"));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(
        new Error(
          stderr || `describing the workflows exited with code ${code}`,
        ),
      );
    });
  });
}

/** A pass for one step of one run, from Mako; retried while Mako is busy. */
async function passFor(workflow, runId, step) {
  let last;
  // Hatchet can lag a run it just started (its tasks show up a moment
  // later), so a refusal is asked again too, for a few seconds.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
    try {
      const res = await fetch(`${makoUrl}/api/workflows/runtime/passes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workflow, runId, step }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body.pass === "string") return body.pass;
      last = new Error(body.error ?? `Mako answered ${res.status}`);
      // A mistake (400) or a key Mako refuses (401) stays so.
      if (res.status === 400 || res.status === 401) break;
    } catch (err) {
      last = err;
    }
  }
  throw new NonRetryableError(
    `Mako gave no pass for this step: ${last?.message ?? last}`,
  );
}

// ---------------------------------------------------------------------------
// Step programs, kept per workflow while they are busy or recently were.
// ---------------------------------------------------------------------------

const uidOf = new Map();
const idle = new Map(); // workflow -> [{ child, timer }]

function spawnFor(workflow) {
  return new Promise((resolve, reject) => {
    const child = startStepProgram(["run", workflow], uidOf.get(workflow));
    child.stderrTail = "";
    child.stderr.on("data", chunk => {
      process.stderr.write(chunk);
      child.stderrTail = (child.stderrTail + chunk).slice(-4000);
    });
    const onExit = code =>
      reject(
        new Error(
          child.stderrTail || `the step program exited with code ${code}`,
        ),
      );
    child.once("exit", onExit);
    child.once("message", message => {
      child.off("exit", onExit);
      if (message?.type === "ready") resolve(child);
      else reject(new Error("The step program did not start"));
    });
  });
}

async function acquire(workflow) {
  const list = idle.get(workflow) ?? [];
  while (list.length) {
    const { child, timer } = list.pop();
    clearTimeout(timer);
    if (child.exitCode === null && child.connected) return child;
  }
  return spawnFor(workflow);
}

function release(workflow, child) {
  if (child.exitCode !== null || !child.connected) return;
  const list = idle.get(workflow) ?? [];
  const entry = { child };
  entry.timer = setTimeout(() => {
    const at = list.indexOf(entry);
    if (at >= 0) list.splice(at, 1);
    child.kill("SIGTERM");
  }, IDLE_MS);
  list.push(entry);
  idle.set(workflow, list);
}

// What a step program may ask of its step's Hatchet context. Everything
// else stays here: the program sees no client, no token, no other run.
const CALLS = {
  log: (ctx, [message, level, extra]) => ctx.log(message, level, extra),
  "logger.debug": (ctx, [m, e]) => ctx.logger.debug(m, e),
  "logger.info": (ctx, [m, e]) => ctx.logger.info(m, e),
  "logger.warn": (ctx, [m, e]) => ctx.logger.warn(m, e),
  "logger.error": (ctx, [m, e]) => ctx.logger.error(m, e),
  refreshTimeout: (ctx, [by]) => ctx.refreshTimeout(by),
  releaseSlot: ctx => ctx.releaseSlot(),
  putStream: (ctx, [data]) => ctx.putStream(data),
  cancel: ctx => ctx.cancel(),
  runChild: (ctx, [name, input, options]) => ctx.runChild(name, input, options),
  spawnChild: (ctx, [name, input, options]) =>
    ctx.spawnChild(name, input, options),
  sleepFor: (ctx, args) => ctx.sleepFor(...args),
  sleepUntil: (ctx, [at]) => ctx.sleepUntil(new Date(at)),
  now: async ctx => (await ctx.now()).toISOString(),
  waitForEvent: (ctx, [key, expression]) => ctx.waitForEvent(key, expression),
};

const safely = read => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

/** The step's context as data, for the step program's own `ctx`. */
async function snapshotOf(ctx, input, parents, kind) {
  const outputs = {};
  for (const parent of parents) {
    outputs[parent] = await ctx.parentOutput(parent);
  }
  return {
    input,
    parents: outputs,
    errors: kind === "onFailure" ? safely(() => ctx.errors()) : undefined,
    workflowRunId: safely(() => ctx.workflowRunId()),
    workflowName: safely(() => ctx.workflowName()),
    taskName: safely(() => ctx.taskName()),
    taskRunExternalId: safely(() => ctx.taskRunExternalId()),
    retryCount: safely(() => ctx.retryCount()),
    additionalMetadata: safely(() => ctx.additionalMetadata()),
    triggeredByEvent: safely(() => ctx.triggeredByEvent()),
    triggers: safely(() => ctx.triggers()),
    filterPayload: safely(() => ctx.filterPayload()),
    parentWorkflowRunId: safely(() => ctx.parentWorkflowRunId()),
    priority: safely(() => ctx.priority()),
  };
}

let nextRun = 0;

/** Run one step of `workflow` in a step program, with its own pass. */
async function runStep(workflow, which, parents, input, ctx) {
  const snapshot = await snapshotOf(ctx, input, parents, which.kind);
  const pass = await passFor(
    workflow,
    snapshot.workflowRunId,
    snapshot.taskName,
  );
  const child = await acquire(workflow);
  const id = ++nextRun;
  const signal = ctx.abortController?.signal;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      child.off("message", onMessage);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onExit = code =>
      finish(
        reject,
        new Error(
          child.stderrTail || `the step program exited with code ${code}`,
        ),
      );
    // A cancelled step stops at once, and its program is not reused.
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(reject, new Error("The step was cancelled"));
    };
    const onMessage = async message => {
      if (message?.type === "call") {
        const handler = CALLS[message.method];
        try {
          if (!handler) {
            throw new Error(`ctx.${message.method} is not available`);
          }
          const value = await handler(ctx, message.args ?? []);
          child.send({
            type: "result",
            id: message.id,
            ok: true,
            value: value ?? null,
          });
        } catch (err) {
          child.send({
            type: "result",
            id: message.id,
            ok: false,
            name: err?.name,
            error: err?.message ?? String(err),
          });
        }
        return;
      }
      if (message?.type !== "done" || message.id !== id) return;
      release(workflow, child);
      if (message.ok) {
        finish(resolve, message.value);
        return;
      }
      const { error } = message;
      const err = error?.nonRetryable
        ? new NonRetryableError(error.message)
        : new Error(error?.message);
      if (error?.stack) err.stack = error.stack;
      finish(reject, err);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.send({ type: "run", id, which, snapshot, pass });
  });
}

// ---------------------------------------------------------------------------
// Register every workflow with Hatchet, each step running elsewhere.
// ---------------------------------------------------------------------------

// The workflows are the folders holding workflow.ts, read here: what the
// describing program (workflow code) says is taken for those names only,
// once each, and the users are given by this list.
const folders = readdirSync(join(root, "workflows"), { withFileTypes: true })
  .filter(
    entry =>
      entry.isDirectory() &&
      existsSync(join(root, "workflows", entry.name, "workflow.ts")),
  )
  .map(entry => entry.name)
  .sort();
for (const [name, uid] of usersFor(folders)) uidOf.set(name, uid);
if (folders.length === 0) {
  // A workflow file in the wrong place is a mistake in the layout, not a
  // deploy: say where it is, so a file one folder too deep is seen at once.
  const found = readdirSync(join(root, "workflows"), { recursive: true })
    .filter(file => String(file).endsWith("workflow.ts"))
    .map(file => `workflows/${file}`);
  if (found.length) {
    console.error(
      "No workflow found. A workflow is the file workflows/<name>/workflow.ts." +
        ` Found instead: ${found.join(", ")}`,
    );
    process.exit(1);
  }
}
const described = await describeWorkflows().catch(err => {
  console.error(err.message);
  process.exit(1);
});
const definitions = folders
  .map(name => described.find(d => d?.name === name))
  .filter(Boolean);
if (definitions.length !== folders.length) {
  const missing = folders.filter(f => !definitions.some(d => d.name === f));
  console.error(`No definition for workflows/${missing.join(", workflows/")}`);
  process.exit(1);
}

const hatchet = HatchetClient.init();
const workflows = definitions.map(definition => {
  const { name } = definition;
  const options = { ...definition.workflow, name };
  if (!active.has(name)) {
    for (const trigger of ["on", "onCrons", "onEvents"])
      delete options[trigger];
  }
  const workflow = hatchet.workflow(options);
  const tasks = new Map();
  for (const task of definition.tasks) {
    const declare = task.durable
      ? workflow.durableTask.bind(workflow)
      : workflow.task.bind(workflow);
    tasks.set(
      task.name,
      declare({
        ...task.options,
        name: task.name,
        parents: task.parents.map(parent => tasks.get(parent)),
        fn: (input, ctx) =>
          runStep(
            name,
            { kind: "task", task: task.name },
            task.parents,
            input,
            ctx,
          ),
      }),
    );
  }
  for (const kind of ["onFailure", "onSuccess"]) {
    if (!definition[kind]) continue;
    workflow[kind]({
      ...definition[kind].options,
      fn: (input, ctx) => runStep(name, { kind }, [], input, ctx),
    });
  }
  return workflow;
});

if (workflows.length === 0) {
  // No workflow at all (the last one was deleted, shared files remain) is a
  // deploy of nothing: this process takes over from the previous one and
  // idles, so what was deleted stops running.
  console.log(`Worker started at ${process.env.GIT_SHA}: no workflows`);
  process.send?.("ready");
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

const worker = await hatchet.worker("workspace", {
  workflows,
  slots: 50,
  labels: { git_sha: process.env.GIT_SHA },
});

process.on("SIGTERM", async () => {
  console.log(`${process.env.GIT_SHA}: finishing running tasks`);
  await worker.stop();
  for (const list of idle.values()) {
    for (const { child } of list) child.kill("SIGTERM");
  }
  process.exit(0);
});

worker.start().catch(err => {
  console.error("Worker stopped:", err);
  process.exit(1);
});
// Ready means connected and registered, not merely started: the previous
// worker is stopped only once this one can take its place.
await worker.waitUntilReady(READY_TIMEOUT_MS).catch(err => {
  console.error("Worker did not connect to Hatchet:", err.message);
  process.exit(1);
});
console.log(
  `Worker started at ${process.env.GIT_SHA}: ${workflows.length} workflows, ` +
    `${definitions.filter(d => active.has(d.name)).length} active` +
    (canSwitchUsers ? "" : " (steps share this user: not in a pod)"),
);
process.send?.("ready");
