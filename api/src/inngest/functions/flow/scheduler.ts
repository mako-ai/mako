import { inngest } from "../../client";
import { getSyncLogger } from "../../logging";
import {
  claimDueScheduledFlows,
  scheduledFlowEventId,
} from "../../../services/flow-schedule-claim";

// Flow scheduler - checks and triggers due flows every 5 minutes
export const flowSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-flow",
    name: "Run Scheduled Flows",
    // One scan at a time; the claim makes overlap safe regardless.
    concurrency: { limit: 1 },
    retries: 3,
    triggers: { cron: "*/5 * * * *" },
  },
  // Run every 5 minutes to check for flows to execute
  async ({ step }) => {
    const scheduleLogger = getSyncLogger("scheduler");

    // Due check + atomic claim of every due flow in ONE step (not one per
    // flow), returning only small claim records — see flow-schedule-claim.
    const { checked, claimed } = await step.run("claim-due-flows", () =>
      claimDueScheduledFlows(new Date()),
    );

    if (claimed.length > 0) {
      // One memoized send with a deterministic id per claimed dispatch, so
      // a retry cannot re-send. No noJitter flag: the flow function applies
      // its own start jitter, which spreads the load.
      await step.sendEvent(
        "trigger-scheduled-flows",
        claimed.map(flow => ({
          id: scheduledFlowEventId(flow),
          name: "flow.execute",
          data: {
            flowId: flow.flowId,
            triggerType: "schedule",
          },
        })),
      );
    }

    const executedFlows = claimed.map(flow => flow.displayName);
    scheduleLogger.info("Scheduled flow runner completed", {
      flowsChecked: checked,
      flowsExecuted: executedFlows.length,
      executedFlows,
    });

    return {
      checked,
      executed: executedFlows.length,
      flows: executedFlows,
    };
  },
);
