/**
 * The keys workflow code runs with, and which workflow a request runs for.
 *
 * Two kinds of key carry `workflows:runtime`: the deployed worker's (one per
 * environment, made on deploy) and a sandbox run's (one per person testing).
 * Workflow code can read the key it runs with, so a workflow name sent by
 * the caller is trusted only from the deployed worker's key, and only when
 * it names a workflow deployed from main. A sandbox run acts as its person.
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

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export type WorkflowIdentity =
  /** Not the deployed worker: the key acts as its creator, as any key. */
  | { kind: "none" }
  /** The deployed worker, for this deployed workflow. */
  | { kind: "workflow"; name: string }
  /**
   * The deployed worker without a deployed workflow's name: it acts as no
   * one who can be listed, never as whoever deployed it.
   */
  | { kind: "worker" };

/** Which workflow, if any, a request made with `key` runs for. */
export function workflowIdentity(
  key: { name?: string; scopes?: string[] } | undefined,
  workspace: { workflows?: { live?: { names?: string[] } } } | null,
  header: string | undefined,
): WorkflowIdentity {
  if (!key?.scopes?.includes("workflows:runtime")) return { kind: "none" };
  if (key.name !== workerKeyName()) return { kind: "none" };
  const deployed = workspace?.workflows?.live?.names ?? [];
  if (header && WORKFLOW_NAME.test(header) && deployed.includes(header)) {
    return { kind: "workflow", name: header };
  }
  return { kind: "worker" };
}
