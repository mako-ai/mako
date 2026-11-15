/**
 * Workflows (docs/src/content/docs/workflows.md): the workspace routes for
 * people, a webhook per workflow, and the runtime routes for the worker —
 * one router each, in ./workflows/.
 *
 * Workflows, runs and logs are read from Hatchet and trimmed
 * (workflows/runs.ts); Mako keeps only the deploy state on the workspace. The
 * runtime routes accept a workspace API key with the `workflows:runtime`
 * scope, which a person cannot put on a key; the key decides the workspace.
 */
export { workflowRoutes } from "./workflows/workspace";
export { workflowHookRoutes } from "./workflows/hooks";
export { workflowRuntimeRoutes } from "./workflows/runtime";
