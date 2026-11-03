// What a workflow file gets as `hatchet` (`import { hatchet } from
// "../hatchet"`) in a test run: the part of Hatchet's SDK the workspace's
// workflows use, recorded here and run by workflow-runner.js in one process.
// Anything else throws, rather than doing something the workers would not.

const unsupported = what => {
  throw new Error(
    `${what} is not supported in test runs; run it on the workers`,
  );
};

/** An object whose other properties throw when read. */
const only = (object, what) =>
  new Proxy(object, {
    get(target, key) {
      if (typeof key === "symbol" || key in target) return target[key];
      // `then` is how `await` asks whether a value is a promise: it is not.
      if (key === "then") return undefined;
      return unsupported(`${what}.${key}`);
    },
  });

const check = (options, allowed, what) => {
  for (const key of Object.keys(options ?? {})) {
    if (!allowed.includes(key)) unsupported(`${what}({ ${key} })`);
  }
};

export const WORKFLOW_OPTIONS = ["name", "description", "on"];
export const TASK_OPTIONS = [
  "name",
  "parents",
  "retries",
  "executionTimeout",
  "fn",
];

/** Every workflow defined in this process, by name: a child run may name one. */
export const workflows = new Map();

export const hatchet = only(
  {
    workflow(options) {
      check(options, WORKFLOW_OPTIONS, "hatchet.workflow");
      const workflow = {
        name: options.name,
        tasks: [],
        task(task) {
          check(task, TASK_OPTIONS, "task");
          const recorded = { ...task, parents: task.parents ?? [] };
          workflow.tasks.push(recorded);
          return recorded;
        },
      };
      workflows.set(options.name, workflow);
      return only(workflow, "workflow");
    },
  },
  "hatchet",
);

/**
 * A step's `ctx`: its logger, its ancestors' outputs, its run's ids, and
 * child runs, run in this process by `run.spawn` (workflow-runner.js).
 */
export function makeContext(log, outputOf, run) {
  const logger = only(
    Object.fromEntries(
      ["debug", "info", "warn", "error"].map(level => [
        level,
        message => log(level, String(message)),
      ]),
    ),
    "ctx.logger",
  );
  const bulk = children =>
    children.map(c => run.spawn(c.workflow, c.input, c.options));
  return only(
    {
      logger,
      parentOutput: async task => outputOf(task),
      workflowRunId: () => run.runId,
      parentWorkflowRunId: () => run.parentRunId,
      childIndex: () => run.childIndex,
      childKey: () => run.childKey,
      runChild: async (workflow, input, options) =>
        run.spawn(workflow, input, options).output,
      runNoWaitChild: async (workflow, input, options) =>
        run.spawn(workflow, input, options),
      bulkRunChildren: async children =>
        Promise.all(bulk(children).map(ref => ref.output)),
      bulkRunNoWaitChildren: async children => bulk(children),
    },
    "ctx",
  );
}
