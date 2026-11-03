/**
 * The concurrency limits EVERY binding build shares — scheduled
 * materializations (apps-binding-refresh.ts) and on-demand async builds
 * (apps-binding-job.ts) alike. Scoped to the Inngest environment with keys
 * that evaluate to the same string in both functions, so the limits are one
 * budget across them, not one per function: a workspace's warehouse sees at
 * most 4 builds at once, and one binding is never built twice concurrently.
 *
 * Both events carry `workspaceId` and `key` (`${projectId}:${binding}`).
 */
import type { ConcurrencyOption } from "inngest/types";

export const APPS_BINDING_BUILD_CONCURRENCY: [
  ConcurrencyOption,
  ConcurrencyOption,
] = [
  {
    scope: "env" as const,
    key: '"apps-binding-ws:" + event.data.workspaceId',
    limit: 4,
  },
  {
    scope: "env" as const,
    key: '"apps-binding:" + event.data.key',
    limit: 1,
  },
];
