/**
 * Deploy a workspace's workflows from `main`, durably. Enqueued where main
 * moves (a push to Mako's git endpoint, a merge, the GitHub push webhook)
 * and swept hourly, the way apps deploy (apps-deploy.ts): the push's own
 * request must return quickly, and on Cloud Run work detached from a request
 * does not reliably run to completion. The deploy itself is on-push.ts.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import { appsRequireConnectedRepo } from "../../apps/config";
import { Workspace } from "../../database/workspace-schema";
import { deployWorkflowsFromRepo } from "../../workflows/on-push";

const log = loggers.api("workflows-deploy");

export const WORKFLOWS_DEPLOY_EVENT = "workflows/deploy.requested";

export interface WorkflowsDeployEventData {
  workspaceId: string;
  /** Who moved main; the worker acts as them when it has to be made. */
  userId?: string;
  /** Why: "push" (git endpoint, merge, webhook), "reconcile" (hourly sweep). */
  reason: "push" | "reconcile";
}

export const workflowsDeployFunction = inngest.createFunction(
  {
    id: "workflows-deploy",
    name: "Workflows: deploy from main",
    // One deploy per workspace, and the newest request wins: a deploy exists
    // to point the worker at the head of main, so a newer request makes an
    // older one moot.
    singleton: { key: "event.data.workspaceId", mode: "cancel" },
    retries: 2,
    triggers: { event: WORKFLOWS_DEPLOY_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as WorkflowsDeployEventData;
    await step.run("deploy", () =>
      deployWorkflowsFromRepo(data.workspaceId, data.userId),
    );
  },
);

/**
 * Every workspace with workflows is deployed again each hour: a webhook
 * that never arrived, a deploy that died, a worker key that went missing.
 * Production only: it reads every bound repository, and an environment
 * without a mirror of its own has nothing to reconcile against.
 */
export const workflowsDeployReconcileFunction = inngest.createFunction(
  {
    id: "workflows-deploy-reconcile",
    name: "Workflows: reconcile deployed workflows with main",
    triggers: { cron: "23 * * * *" },
  },
  async ({ step }) => {
    if (!appsRequireConnectedRepo()) return { skipped: "not production" };
    const workspaceIds = await step.run("list-deployed", async () =>
      (
        await Workspace.find({ "workflows.live": { $exists: true } })
          .select("_id")
          .lean()
      ).map(w => w._id.toString()),
    );
    await step.run("request", () =>
      Promise.all(
        workspaceIds.map(workspaceId =>
          requestWorkflowsDeploy(workspaceId, undefined, "reconcile"),
        ),
      ),
    );
    log.info("Workflows reconcile requested", { count: workspaceIds.length });
    return { requested: workspaceIds.length };
  },
);

/** Ask for a workspace's workflows to be deployed from main. */
export async function requestWorkflowsDeploy(
  workspaceId: string,
  userId: string | undefined,
  reason: WorkflowsDeployEventData["reason"],
): Promise<void> {
  await inngest.send({
    name: WORKFLOWS_DEPLOY_EVENT,
    data: { workspaceId, userId, reason } satisfies WorkflowsDeployEventData,
  });
}
