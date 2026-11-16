/**
 * The workspace repo clones in progress on this instance (target.ts,
 * ensureLocalRepo). Its own module so the request middleware can ask
 * without loading the git and GitHub code.
 */
export const cloneInFlight = new Map<string, Promise<void>>();

/**
 * Whether this instance is cloning the workspace's repo right now. Routes in
 * the repo-work pool answer 503 + Retry-After instead of queueing behind the
 * clone (middleware/concurrency-limit.ts, `shedWhileCloning`).
 */
export function repoCloneInProgress(workspaceId: string): boolean {
  return cloneInFlight.has(workspaceId);
}
