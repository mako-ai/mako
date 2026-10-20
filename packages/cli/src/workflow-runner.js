// A test run of a workflow: workflows/<name>/workflow.ts run in this process,
// with no Hatchet engine. Its steps run once each, parents first, each given
// its input and its ancestors' outputs; `../lib/mako` is the workers' own
// file, so every Mako call is real and has the rights of the key it carries.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register as registerTsx } from "tsx/esm/api";
import { makeContext, workflows } from "./workflow-hatchet.js";

/** Hatchet's default when a step sets no executionTimeout. */
const DEFAULT_TIMEOUT = "60s";

/**
 * lib/mako.ts as the workers run it: the monorepo's, the copy packed with
 * the CLI, or, in a sandbox, the runtime's own (the CLI files sit in its cli/).
 */
function makoFile() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(
      here,
      "../../../deploy/workflows/runtime/defaults/lib/mako.ts",
    ),
    path.resolve(here, "../runtime/mako.ts"),
    path.resolve(here, "../defaults/lib/mako.ts"),
  ].find(file => fs.existsSync(file));
}

let loaded = false;
function registerLoader(repoRoot) {
  if (loaded) return;
  loaded = true;
  registerTsx();
  register("./workflow-loader.js", import.meta.url, {
    data: {
      workflowsURL: pathToFileURL(path.join(repoRoot, "workflows")).href + "/",
      packagesURL: import.meta.url,
      supplied: {
        hatchet: new URL("./workflow-hatchet.js", import.meta.url).href,
        "lib/mako": pathToFileURL(makoFile()).href,
      },
    },
  });
}

export function timeoutMs(value = DEFAULT_TIMEOUT) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(value));
  if (!match)
    throw new Error(
      `executionTimeout "${value}" is not like "30s", "5m" or "1h"`,
    );
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
  return Number(match[1]) * unit;
}

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${name} ran past its executionTimeout (${ms / 1000}s)`),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The workflow a file default-exports, checked as the workers' build checks it. */
/** The checkout the run's workflows come from: a child run may name another. */
let checkoutRoot;

export async function loadWorkflow(checkout, name) {
  // Node names modules by their real path (/private/var/… for /var/…).
  const repoRoot = fs.realpathSync(checkout);
  checkoutRoot ??= repoRoot;
  const file = path.join(repoRoot, "workflows", name, "workflow.ts");
  if (!fs.existsSync(file)) {
    throw new Error(
      `no workflow "${name}": workflows/${name}/workflow.ts does not exist`,
    );
  }
  registerLoader(repoRoot);
  const workflow = (await import(pathToFileURL(file).href)).default;
  if (!Array.isArray(workflow?.tasks) || workflow.name !== name) {
    throw new Error(
      `workflows/${name}/workflow.ts must default-export the workflow named "${name}"`,
    );
  }
  return workflow;
}

/**
 * Run a workflow's steps, or with `task` that one step alone, its parents'
 * outputs taken from `saved` (an earlier run's result). Answers the run's
 * result: each step's status, attempts, timings, output, error and logs.
 */
export async function runWorkflow(
  workflow,
  {
    input = {},
    task,
    saved,
    onLog = () => {},
    // A child run's place: its parent's run, and its index and key there.
    run = { runId: randomUUID() },
  },
) {
  const running = (globalThis.makoWorkflow ??= new AsyncLocalStorage());
  const previous = new Map((saved?.tasks ?? []).map(t => [t.name, t]));
  const steps = new Map();
  const outputOf = step => {
    const done = steps.get(step.name) ?? previous.get(step.name);
    if (done?.status !== "COMPLETED") {
      throw new Error(`"${step.name}" has no output in this run`);
    }
    return done.output;
  };

  if (task && !workflow.tasks.some(t => t.name === task)) {
    throw new Error(`"${workflow.name}" has no step "${task}"`);
  }
  const started = Date.now();
  for (const step of workflow.tasks) {
    if (task && step.name !== task) continue;
    const result = {
      name: step.name,
      status: "RUNNING",
      attempts: 0,
      logs: [],
    };
    steps.set(step.name, result);
    const missing = step.parents.find(parent => {
      const done = steps.get(parent.name) ?? previous.get(parent.name);
      return done?.status !== "COMPLETED";
    });
    if (missing) {
      result.status = "CANCELLED";
      result.error = task
        ? `"${missing.name}" has no saved output: run the whole workflow first`
        : `"${missing.name}" did not complete`;
      onLog({ task: step.name, level: "warn", message: result.error });
      continue;
    }
    const log = (level, message) => {
      const line = { at: new Date().toISOString(), level, message };
      result.logs.push(line);
      onLog({ task: step.name, ...line });
    };
    // A child run (ctx.runChild and its kin) runs here too, its steps and
    // logs kept under this step, and resolves to its outputs by step name.
    let spawned = 0;
    const pending = [];
    const spawn = (child, childInput = {}, options = {}) => {
      const name = typeof child === "string" ? child : child?.name;
      const index = spawned++;
      const entry = {
        workflow: name,
        runId: randomUUID(),
        index,
        key: options.key,
        attempt: result.attempts,
        status: "RUNNING",
      };
      (result.children ??= []).push(entry);
      // By name, as the workers find it: defined in this process already, or
      // its own folder in the checkout, loaded now.
      const found =
        typeof child !== "string"
          ? Promise.resolve(child)
          : Promise.resolve(
              workflows.get(child) ?? loadWorkflow(checkoutRoot, child),
            );
      const output = found.then(target =>
        runWorkflow(target, {
          input: childInput,
          onLog: line =>
            onLog({
              ...line,
              task: `${step.name} › ${target.name}[${index}] ${line.task}`,
            }),
          run: {
            runId: entry.runId,
            parentRunId: run.runId,
            childIndex: index,
            childKey: options.key,
          },
        }).then(done => {
          Object.assign(entry, done, { workflow: target.name });
          const failed = done.tasks.find(t => t.status !== "COMPLETED");
          if (failed) {
            throw new Error(
              `child ${target.name}[${index}] failed in "${failed.name}": ${String(failed.error ?? failed.status).split("\n")[0]}`,
            );
          }
          return Object.fromEntries(done.tasks.map(t => [t.name, t.output]));
        }),
      );
      // A child that could not start (no such workflow) is a failed child.
      output.catch(error => {
        if (entry.status === "RUNNING") {
          Object.assign(entry, {
            status: "FAILED",
            error: String(error?.message ?? error),
          });
        }
      });
      // Waited for or not, a failed child is not an unhandled rejection.
      output.catch(() => undefined);
      pending.push(output);
      return {
        workflowRunId: entry.runId,
        getWorkflowRunId: async () => entry.runId,
        output,
        result: () => output,
      };
    };
    const begin = Date.now();
    for (let attempt = 1; attempt <= 1 + (step.retries ?? 0); attempt++) {
      result.attempts = attempt;
      try {
        result.output = await running.run(workflow.name, () =>
          withTimeout(
            Promise.resolve().then(() =>
              step.fn(input, makeContext(log, outputOf, { ...run, spawn })),
            ),
            timeoutMs(step.executionTimeout),
            step.name,
          ),
        );
        result.status = "COMPLETED";
        delete result.error;
      } catch (error) {
        result.status = "FAILED";
        result.error =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        log(
          "error",
          `attempt ${attempt} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      // The step ends when every child it started has, as the workers'
      // record shows them: a run that failed fast still has its children.
      await Promise.allSettled(pending.splice(0));
      if (result.status === "COMPLETED") break;
    }
    result.durationMs = Date.now() - begin;
  }

  // A step rerun alone keeps the rest of the earlier run around it.
  const tasks = workflow.tasks
    .map(t => steps.get(t.name) ?? previous.get(t.name))
    .filter(Boolean);
  return {
    workflow: workflow.name,
    runId: run.runId,
    input,
    status: tasks.every(t => t.status === "COMPLETED") ? "COMPLETED" : "FAILED",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    tasks,
  };
}
