// A step program: runs workflow code, and nothing else. Started by the
// dispatcher (worker.mjs) as the workflow's own user, with no Mako key and no
// Hatchet token: it calls Mako with the pass the dispatcher sends for each
// step (api/src/workflows/pass.ts), and asks the dispatcher for anything that
// needs Hatchet (a log line, a child run, a durable sleep).
//
//   node step.mjs describe            print every workflow's definition
//   node step.mjs run <workflow>      run that workflow's steps, one at a time
//
// Env: WORKFLOWS_ROOT, MAKO_URL. Talks to the dispatcher over the IPC channel.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();
const [mode, only] = process.argv.slice(2);
const dir = join(process.env.WORKFLOWS_ROOT, "workflows");
const load = file => import(pathToFileURL(join(dir, file)).href);
const send = message => process.send?.(message);

// Workflow code builds its workflows with the Hatchet client of
// workflows/hatchet.ts, which needs a token to start. This one names no
// tenant and no reachable server: declaring workflows works, connecting
// does not, and the real token never comes near workflow code.
const claims = token =>
  Buffer.from(JSON.stringify(token)).toString("base64url");
process.env.HATCHET_CLIENT_TOKEN = [
  claims({ alg: "none", typ: "JWT" }),
  claims({
    sub: "00000000-0000-0000-0000-000000000000",
    server_url: "http://127.0.0.1:9",
    grpc_broadcast_address: "127.0.0.1:9",
  }),
  "unsigned",
].join(".");
process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
// Older copies of lib/mako read their key when loaded; the pass of the step
// running replaces it on every request (below).
process.env.MAKO_API_KEY = "mwp_pending";

/** The workflow modules under workflows/, by folder name. */
async function loadWorkflows(names) {
  const found = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (names && !names.includes(entry.name)) continue;
    const file = join(entry.name, "workflow.ts");
    if (!entry.isDirectory() || !existsSync(join(dir, file))) continue;
    const workflow = (await load(file)).default;
    const name = workflow?.definition?.name;
    if (name !== entry.name) {
      throw new Error(
        `workflows/${file} must default-export the workflow named "${entry.name}"` +
          (name ? `, not "${name}"` : ""),
      );
    }
    found.set(name, workflow.definition);
  }
  return found;
}

// ---------------------------------------------------------------------------
// describe: what the dispatcher registers with Hatchet, as plain data.
// ---------------------------------------------------------------------------

/**
 * `value` as plain JSON, or an error naming `where`. A step's options cross
 * to the dispatcher, which runs no workflow code: a function or an object of
 * a class (a condition, a schema) cannot.
 */
function plain(value, where) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value))
    return value.map((v, i) => plain(v, `${where}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (
    typeof value === "object" &&
    (proto === Object.prototype || proto === null)
  ) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const copied = plain(v, `${where}.${key}`);
      if (copied !== undefined) out[key] = copied;
    }
    return out;
  }
  throw new Error(
    `${where} is not supported in a deployed workflow on Mako yet` +
      (typeof value === "function"
        ? " (a function)"
        : " (an object of a class)"),
  );
}

// Options Mako drops rather than refuses: they only check or describe the
// input where a run is started, and a run is checked where it runs.
const DROPPED_WORKFLOW_KEYS = new Set(["inputValidator", "outputValidator"]);

function describeTask(task, where, durable) {
  const { fn, parents, ...options } = task;
  if (typeof fn !== "function") throw new Error(`${where} has no fn`);
  return {
    durable,
    parents: (parents ?? []).map(p => p.name),
    options: plain(options, where),
  };
}

function describeHook(hook, where) {
  if (!hook) return undefined;
  if (typeof hook === "function") return { options: {} };
  const { fn, ...options } = hook;
  if (typeof fn !== "function") throw new Error(`${where} has no fn`);
  return { options: plain(options, where) };
}

function describe(name, definition) {
  const { _tasks, _durableTasks, onFailure, onSuccess, ...rest } = definition;
  const workflow = {};
  for (const [key, value] of Object.entries(rest)) {
    if (DROPPED_WORKFLOW_KEYS.has(key)) continue;
    const copied = plain(value, `workflows/${name}: ${key}`);
    if (copied !== undefined) workflow[key] = copied;
  }
  // Declaration order, which puts every parent before its children.
  const tasks = [
    ...(_tasks ?? []).map(t => [t, false]),
    ...(_durableTasks ?? []).map(t => [t, true]),
  ].map(([task, durable]) => ({
    name: task.name,
    ...describeTask(task, `workflows/${name}: task ${task.name}`, durable),
  }));
  return {
    name,
    workflow,
    tasks,
    onFailure: describeHook(onFailure, `workflows/${name}: onFailure`),
    onSuccess: describeHook(onSuccess, `workflows/${name}: onSuccess`),
  };
}

if (mode === "describe") {
  try {
    const definitions = [];
    for (const [name, definition] of await loadWorkflows()) {
      definitions.push(describe(name, definition));
    }
    send({ type: "described", definitions });
  } catch (err) {
    send({ type: "failed", error: err?.message ?? String(err) });
  }
  // Workflow code may leave timers or sockets open: the answer is sent.
  setTimeout(() => process.exit(0), 100);
} else if (mode === "run") {
  await runSteps(only);
} else {
  console.error("usage: step.mjs describe | run <workflow>");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// run: one workflow's steps, one at a time, each with its own pass.
// ---------------------------------------------------------------------------

async function runSteps(workflowName) {
  const definitions = await loadWorkflows([workflowName]);
  const definition = definitions.get(workflowName);
  if (!definition) throw new Error(`No workflow ${workflowName}`);

  const step = new AsyncLocalStorage();
  // lib/mako names the workflow and run from these, as it did in-process.
  globalThis.makoWorkflow = {
    getStore: () => (step.getStore() ? workflowName : undefined),
  };
  globalThis.makoRun = {
    getStore: () => {
      const s = step.getStore();
      return s
        ? { runId: s.snapshot.workflowRunId, step: s.snapshot.taskName }
        : undefined;
    },
  };

  // Every request to Mako carries the pass of the step it is made for.
  const makoOrigin = (() => {
    try {
      return new URL(process.env.MAKO_URL ?? "http://localhost:8080").origin;
    } catch {
      return null;
    }
  })();
  const baseFetch = globalThis.fetch;
  let currentPass = null;
  globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      // Not an absolute URL: not Mako.
    }
    const pass = step.getStore()?.pass ?? currentPass;
    if (!pass || origin !== makoOrigin) return baseFetch(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${pass}`);
    return baseFetch(input, { ...init, headers });
  };

  const fnOf = which => {
    if (which.kind === "onFailure" || which.kind === "onSuccess") {
      const hook = definition[which.kind];
      return typeof hook === "function" ? hook : hook?.fn;
    }
    const task = [
      ...(definition._tasks ?? []),
      ...(definition._durableTasks ?? []),
    ].find(t => t.name === which.task);
    return task?.fn;
  };

  // Calls the dispatcher answers with the step's real Hatchet context.
  let nextCall = 0;
  const pending = new Map();
  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextCall;
      pending.set(id, { resolve, reject });
      send({ type: "call", id, method, args });
    });
  const nameOf = workflow =>
    typeof workflow === "string"
      ? workflow
      : (workflow?.definition?.name ?? workflow?.name);

  const contextFor = snapshot => {
    const known = {
      input: snapshot.input,
      abortController: new AbortController(),
      cancelled: false,
      rethrowIfCancelled() {},
      parentOutput: async task => {
        const name = typeof task === "string" ? task : task?.name;
        return snapshot.parents?.[name];
      },
      stepOutput: name => snapshot.parents?.[name],
      workflowInput: () => snapshot.input,
      errors: () => snapshot.errors ?? {},
      stepRunErrors: () => snapshot.errors ?? {},
      workflowRunId: () => snapshot.workflowRunId,
      workflowName: () => snapshot.workflowName,
      taskName: () => snapshot.taskName,
      stepName: () => snapshot.taskName,
      taskRunExternalId: () => snapshot.taskRunExternalId,
      retryCount: () => snapshot.retryCount ?? 0,
      additionalMetadata: () => snapshot.additionalMetadata ?? {},
      triggeredByEvent: () => snapshot.triggeredByEvent ?? false,
      triggers: () => snapshot.triggers ?? {},
      filterPayload: () => snapshot.filterPayload ?? {},
      parentWorkflowRunId: () => snapshot.parentWorkflowRunId,
      priority: () => snapshot.priority,
      log: (message, level, extra) =>
        call("log", [String(message), level, extra]),
      logger: Object.fromEntries(
        ["debug", "info", "warn", "error"].map(level => [
          level,
          (message, extra) => call(`logger.${level}`, [String(message), extra]),
        ]),
      ),
      refreshTimeout: by => call("refreshTimeout", [by]),
      releaseSlot: () => call("releaseSlot", []),
      putStream: data =>
        call("putStream", [
          typeof data === "string" ? data : Buffer.from(data).toString(),
        ]),
      cancel: () => call("cancel", []),
      runChild: (workflow, input, options) =>
        call("runChild", [nameOf(workflow), input, options]),
      spawnChild: (workflow, input, options) =>
        call("spawnChild", [nameOf(workflow), input, options]),
      sleepFor: (duration, ...rest) => call("sleepFor", [duration, ...rest]),
      sleepUntil: wakeAt =>
        call("sleepUntil", [new Date(wakeAt).toISOString()]),
      now: async () => new Date(await call("now", [])),
      waitForEvent: (key, expression) =>
        call("waitForEvent", [key, expression]),
    };
    return new Proxy(known, {
      get(target, prop) {
        if (prop in target || typeof prop === "symbol" || prop === "then") {
          return target[prop];
        }
        return () => {
          throw new Error(
            `ctx.${String(prop)} is not available to a deployed workflow step on Mako yet`,
          );
        };
      },
    });
  };

  const errorOf = err => ({
    name: err?.name ?? "Error",
    message: err?.message ?? String(err),
    stack: err?.stack,
    nonRetryable: err?.name === "NonRetryableError",
  });

  process.on("message", async message => {
    if (message?.type === "result") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else
        waiting.reject(
          Object.assign(new Error(message.error), { name: message.name }),
        );
      return;
    }
    if (message?.type !== "run") return;
    const { id, which, snapshot, pass } = message;
    const fn = fnOf(which);
    if (typeof fn !== "function") {
      send({
        type: "done",
        id,
        ok: false,
        error: errorOf(new Error(`No step ${which.task ?? which.kind}`)),
      });
      return;
    }
    currentPass = pass;
    try {
      const value = await step.run({ pass, snapshot }, () =>
        fn(snapshot.input, contextFor(snapshot)),
      );
      send({
        type: "done",
        id,
        ok: true,
        value: value === undefined ? null : value,
      });
    } catch (err) {
      send({ type: "done", id, ok: false, error: errorOf(err) });
    } finally {
      currentPass = null;
    }
  });
  send({ type: "ready" });
}
