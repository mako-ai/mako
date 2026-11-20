/**
 * The dbt schema-gap check and hold of a push to main, as Inngest work.
 *
 * The check compiles the dbt project (up to 10 minutes) and asks the
 * warehouse for column lists. The GitHub webhook runs detached from its
 * request, and Cloud Run may stop an instance mid-work, so the webhook only
 * requests the deploys of apps that read no dbt model and sends this event
 * for the rest (apps/dbt-before-deploy.ts). One check per workspace at a
 * time: they share the project's ad-hoc dbt directory anyway.
 *
 * When every retry fails, the apps this check holds deploy at once: a failed
 * check must never leave an app unpublished.
 */
import {
  APPS_DBT_HOLD_EVENT,
  settleDbtBeforeDeploy,
  type AppsDbtHoldEventData,
} from "../../apps/dbt-before-deploy";
import { inngest } from "../client";
import { loggers } from "../../logging";

const log = loggers.inngest();

export const appsDbtHoldFunction = inngest.createFunction(
  {
    id: "apps-dbt-hold",
    name: "Apps: check the dbt schema gap before deploying",
    concurrency: [{ key: "event.data.workspaceId", limit: 1 }],
    retries: 1,
    onFailure: async ({ event, error }) => {
      const data = (
        event as { data?: { event?: { data?: Partial<AppsDbtHoldEventData> } } }
      )?.data?.event?.data;
      if (!data?.workspaceId || !data.sha || !data.prep?.readers?.length) {
        return;
      }
      log.error("dbt schema-gap check failed for good; deploying now", {
        workspaceId: data.workspaceId,
        sha: data.sha,
        error: error instanceof Error ? error.message : String(error),
      });
      const { requestAppDeploys } = await import("./apps-deploy");
      await requestAppDeploys(
        data.workspaceId,
        data.prep.readers,
        data.sha,
        "push",
      );
    },
    triggers: { event: APPS_DBT_HOLD_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as AppsDbtHoldEventData;
    return step.run("settle", () => settleDbtBeforeDeploy(data));
  },
);
