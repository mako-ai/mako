/**
 * One run, sandbox (read from the person's box, sandbox.ts) or deployed
 * (read from the workspace's Hatchet, runs.ts), waiting on the server up to
 * `wait` seconds for it to end. Shared by workflows_status and the routes.
 */
import { requireTenant } from "./hatchet";
import { readRun } from "./runs";
import { isSandboxRunId, readSandboxRun } from "./sandbox";
import { waitFor, waitSeconds } from "./wait";

const ACTIVE = ["QUEUED", "RUNNING", "PENDING"];

export async function waitForRun(
  workspaceId: string,
  userId: string | undefined,
  runId: string,
  options: { wait?: number; full?: boolean } = {},
) {
  const sandbox = isSandboxRunId(runId);
  const read = async () => {
    if (!sandbox) return readRun(await requireTenant(workspaceId), runId);
    if (!userId) throw new Error("A sandbox run is read by its person.");
    return readSandboxRun(workspaceId, userId, runId, { full: options.full });
  };
  const { value: run, done } = await waitFor(
    read,
    value => !ACTIVE.includes(String(value.status)),
    {
      seconds: waitSeconds(options.wait),
      intervalMs: sandbox ? 2000 : 3000,
    },
  );
  return { run, done };
}
