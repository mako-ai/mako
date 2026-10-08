/**
 * What is deployed for a workspace's workflows: the live code and, when there
 * is unmerged work, its preview. Read from the deploy state on the workspace,
 * which the push hook and the worker's reports keep (see on-push.ts).
 */
import { Workspace } from "../database/workspace-schema";
import { hasInstanceHatchet } from "./hatchet";

export interface Deployment {
  /** The commit the worker reports running. Null before the first good deploy. */
  liveSha: string | null;
  /** The commit the worker should run. Differs from live while switching. */
  targetSha: string | null;
  /** True while the worker has not yet switched to `targetSha`. */
  deploying: boolean;
  /** The build output when `targetSha` could not be started. */
  buildError: string | null;
}

function deployment(
  target?: { sha: string },
  live?: { sha: string },
  failed?: { sha: string; error: string },
): Deployment {
  const targetSha = target?.sha ?? null;
  const liveSha = live?.sha ?? null;
  const buildError =
    targetSha && failed?.sha === targetSha ? failed.error : null;
  return {
    liveSha,
    targetSha,
    deploying: targetSha !== liveSha && !buildError,
    buildError,
  };
}

export async function readWorkflowsStatus(workspaceId: string) {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows")
    .lean();
  const state = workspace?.workflows;
  return {
    enabled: state?.enabled === true,
    // False when no Hatchet token exists for this workspace and the
    // installation has none to share: the UI hides Workflows.
    configured: Boolean(state?.hatchetToken) || hasInstanceHatchet(),
    deployment: deployment(state?.target, state?.live, state?.failed),
    /** Unmerged work running next to live, or null when there is none. */
    preview: state?.preview
      ? {
          branch: state.preview.branch,
          ...deployment(state.preview, state.previewLive, state.previewFailed),
        }
      : null,
    dashboardUrl: process.env.HATCHET_DASHBOARD_URL ?? null,
  };
}
