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
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
} from "./functions/webhook-flow";
import {
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
} from "./functions/dashboard-refresh";
import { syncBackfillEntityFunction } from "./functions/sync-entity";
import { usageReportingFunction } from "./functions/usage-reporting";
import { loggers } from "../logging";

const baseFunctions = [
  flowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  syncBackfillEntityFunction,
  dashboardRefreshFunction,
  cleanupAbandonedMaterializationRunsFunction,
  usageReportingFunction,
];

const allWebhookFunctions = [
  webhookEventProcessFunction,
  webhookEventProcessCdcFunction,
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
];

/**
 * Build the function list lazily so it reads env vars AFTER dotenv.config() runs.
 * Cached after first call.
 */
let _functions: typeof baseFunctions | null = null;
export function getFunctions() {
  if (_functions) return _functions;

  const isDevelopment =
    process.env.NODE_ENV !== "production" ||
    process.env.DISABLE_SCHEDULED_SYNC === "true";

  const disableWebhookProcessing =
    process.env.DISABLE_WEBHOOK_PROCESSING === "true";

  const webhookFunctions = disableWebhookProcessing ? [] : allWebhookFunctions;

  _functions = isDevelopment
    ? [...baseFunctions, ...webhookFunctions]
    : [
        ...baseFunctions,
        ...webhookFunctions,
        flowSchedulerFunction,
        dashboardSchedulerFunction,
      ];

  return _functions;
}

/**
 * Log Inngest configuration status
 * This should be called after logging is initialized
 */
export function logInngestStatus(): void {
  const logger = loggers.inngest();

  const isDev =
    process.env.NODE_ENV !== "production" ||
    process.env.DISABLE_SCHEDULED_SYNC === "true";
  if (isDev) {
    logger.warn("Scheduled flows are DISABLED in development mode");
  } else {
    logger.info("Scheduled flows are ENABLED in production mode");
  }

  if (process.env.DISABLE_WEBHOOK_PROCESSING === "true") {
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
  syncBackfillEntityFunction,
  webhookEventProcessFunction,
  webhookEventProcessCdcFunction,
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
  usageReportingFunction,
};
