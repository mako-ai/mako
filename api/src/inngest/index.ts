import { inngest } from "./client";
import {
  flowFunction,
  flowSchedulerFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
} from "./functions/flow";
import {
  webhookEventProcessFunction,
  webhookEventProcessCdcFunction,
  webhookCleanupFunction,
  webhookRetryFunction,
  cdcMaterializeFunction,
} from "./functions/webhook-flow";
import {
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
} from "./functions/dashboard-refresh";
import { loggers } from "../logging";

const isDevelopment =
  process.env.NODE_ENV !== "production" ||
  process.env.DISABLE_SCHEDULED_SYNC === "true";

const disableWebhookProcessing =
  process.env.DISABLE_WEBHOOK_PROCESSING === "true";

const baseFunctions = [
  flowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  dashboardRefreshFunction,
  cleanupAbandonedMaterializationRunsFunction,
];

const webhookFunctions = disableWebhookProcessing
  ? []
  : [
      webhookEventProcessFunction,
      webhookEventProcessCdcFunction,
      webhookCleanupFunction,
      webhookRetryFunction,
      cdcMaterializeFunction,
    ];

export const functions = isDevelopment
  ? [...baseFunctions, ...webhookFunctions]
  : [
      ...baseFunctions,
      ...webhookFunctions,
      flowSchedulerFunction,
      dashboardSchedulerFunction,
    ];

/**
 * Log Inngest configuration status
 * This should be called after logging is initialized
 */
export function logInngestStatus(): void {
  const logger = loggers.inngest();
  if (isDevelopment) {
    logger.warn("Scheduled flows are DISABLED in development mode");
  } else {
    logger.info("Scheduled flows are ENABLED in production mode");
  }
  if (disableWebhookProcessing) {
    logger.warn(
      "Webhook processing is DISABLED (DISABLE_WEBHOOK_PROCESSING=true)",
    );
  }
}

// Re-export for named imports
export { inngest };
export {
  flowFunction,
  flowSchedulerFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  webhookEventProcessFunction,
  webhookEventProcessCdcFunction,
  webhookCleanupFunction,
  webhookRetryFunction,
  cdcMaterializeFunction,
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
};
