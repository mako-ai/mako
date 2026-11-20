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
 * Two steps, so a retry reuses what finished: "plan" compiles and checks,
 * "hold" requests the free deploys and starts the build. A retry of "hold"
 * never re-compiles and never re-requests a deploy that is in flight (the
 * deploy function cancels the older run of an app).
 *
 * When every retry fails, the apps this check would hold deploy at once, but
 * not the ones a dbt run already holds for this commit: a failed check must
 * never leave an app unpublished.
 */
import {
  APPS_DBT_HOLD_EVENT,
  applyDbtHold,
  deployReadersAfterFailedCheck,
  planDbtHold,
  type AppsDbtHoldEventData,
} from "../../apps/dbt-before-deploy";
import { inngest } from "../client";
import { loggers } from "../../logging";

const log = loggers.inngest();

/** What Inngest hands `onFailure`: the failed run's own event is nested. */
export async function appsDbtHoldOnFailure({
  event,
  error,
}: {
  event: unknown;
  error: unknown;
}): Promise<string[]> {
  const data = (
    event as { data?: { event?: { data?: Partial<AppsDbtHoldEventData> } } }
  )?.data?.event?.data;
  if (!data?.workspaceId || !data.sha || !data.prep?.readers?.length) return [];
  log.error("dbt schema-gap check failed for good; deploying now", {
    workspaceId: data.workspaceId,
    sha: data.sha,
    error: error instanceof Error ? error.message : String(error),
  });
  return deployReadersAfterFailedCheck(data as AppsDbtHoldEventData);
}

export const appsDbtHoldFunction = inngest.createFunction(
  {
    id: "apps-dbt-hold",
    name: "Apps: check the dbt schema gap before deploying",
    concurrency: [{ key: "event.data.workspaceId", limit: 1 }],
    retries: 1,
    onFailure: async args => {
      await appsDbtHoldOnFailure(args);
    },
    triggers: { event: APPS_DBT_HOLD_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as AppsDbtHoldEventData;
    const plan = await step.run("plan", () => planDbtHold(data));
    return step.run("hold", () => applyDbtHold(data, plan));
  },
);
