/**
 * The keys workflow code runs with, and which workflow a request runs for.
 *
 * Two kinds of key carry `workflows:runtime`: the deployed worker's (one per
 * environment, made on deploy) and a sandbox run's (one per person testing).
 * Deployed workflow code never holds the worker key: it calls Mako with a
 * workflow pass for its step (pass.ts). A sandbox run's key, which the code
 * being tested can read, acts as its person.
 */
import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { workflowsNamePrefix } from "./hatchet";

/** One key per environment that runs a worker: previews share a database. */
export const workerKeyName = () =>
  `Workflows worker ${workflowsNamePrefix()}`.trim();

export const sandboxKeyName = (userId: string) => `Workflows sandbox ${userId}`;

// `query:write` reads everywhere and writes only through connections that
// list the workflow (or, in a sandbox, the person) as a writer
// (access/connection-writes.ts).
export const WORKER_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:write",
  "workflows:runtime",
];

/**
 * Whether `key` is this environment's deployed worker key. On its own it
 * acts as no one who can be listed, never as whoever deployed it: a deployed
 * workflow acts as itself only with a workflow pass (pass.ts), which only the
 * dispatcher, holding this key, can ask for.
 */
export function isWorkerKey(
  key: { name?: string; scopes?: string[] } | undefined,
): boolean {
  return (
    !!key?.scopes?.includes("workflows:runtime") && key.name === workerKeyName()
  );
}
