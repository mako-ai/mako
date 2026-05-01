import { inngest } from "../client";
import { loggers } from "../../logging";
import type { FlowRunTerminalEventData } from "../../services/flow-run-notification.types";
import {
  deliverNotificationJob,
  fanOutTerminalRunNotifications,
} from "../../services/flow-run-notification.service";

const logger = loggers.inngest("notification");

export const flowRunTerminalFanoutFunction = inngest.createFunction(
  {
    id: "flow-run-notification-fanout",
    name: "Flow run notification fan-out",
    retries: 3,
  },
  { event: "flow.run.terminal" },
  async ({ event, step }) => {
    const data = event.data as FlowRunTerminalEventData;
    await step.run("fan-out-rules", async () => {
      const result = await fanOutTerminalRunNotifications(data);
      logger.info("Notification fan-out complete", {
        workspaceId: data.workspaceId,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        runId: data.runId,
        deliveriesQueued: result.deliveriesQueued,
      });
      return result;
    });
  },
);

export const notificationDeliverFunction = inngest.createFunction(
  {
    id: "notification-deliver",
    name: "Deliver notification",
    retries: 5,
  },
  { event: "notification/deliver" },
  async ({ event, step }) => {
    await step.run("deliver", async () => {
      await deliverNotificationJob(event.data);
    });
  },
);
