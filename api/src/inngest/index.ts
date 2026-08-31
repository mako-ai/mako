import { inngest } from "./client";
import type { InngestFunction } from "inngest";
import {
  flowFunction,
  flowSchedulerFunction,
  cdcScheduledBackfillFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
} from "./functions/flow";
import {
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
} from "./functions/webhook-flow";
import {
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
} from "./functions/dashboard-refresh";
import {
  appsBindingMaterializeFunction,
  appsBindingSchedulerFunction,
} from "./functions/apps-binding-refresh";
import {
  appsDeployFunction,
  appsDeployReconcileFunction,
} from "./functions/apps-deploy";
import { syncBackfillEntityFunction } from "./functions/sync-entity";
import { cdcRepartitionFunction } from "./functions/cdc-repartition";
import { usageReportingFunction } from "./functions/usage-reporting";
import { modelCatalogRefreshFunction } from "./functions/model-catalog-refresh";
import {
  scheduledQueryExecutorFunction,
  scheduledQuerySchedulerFunction,
} from "./functions/scheduled-query";
import {
  flowRunTerminalFanoutFunction,
  notificationDeliverFunction,
} from "./functions/flow-run-notifications";
import {
  dbtRunExecutorFunction,
  dbtRunCancelFunction,
  dbtSchedulerFunction,
  dbtRunSweeperFunction,
} from "./functions/dbt-run";
import { consoleDescriptionFunction } from "./functions/console-description";
import { loggers } from "../logging";

const baseFunctions = [
  flowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  syncBackfillEntityFunction,
  cdcRepartitionFunction,
  dashboardRefreshFunction,
  cleanupAbandonedMaterializationRunsFunction,
  appsBindingMaterializeFunction,
  appsDeployFunction,
  usageReportingFunction,
  modelCatalogRefreshFunction,
  scheduledQueryExecutorFunction,
  flowRunTerminalFanoutFunction,
  notificationDeliverFunction,
  dbtRunExecutorFunction,
  dbtRunCancelFunction,
  dbtRunSweeperFunction,
  consoleDescriptionFunction,
];

const allWebhookFunctions = [
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
];

/**
 * Build the function list lazily so it reads env vars AFTER dotenv.config() runs.
 * Cached after first call.
 */
let _functions: InngestFunction.Like[] | null = null;
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
        cdcScheduledBackfillFunction,
        dashboardSchedulerFunction,
        appsBindingSchedulerFunction,
        appsDeployReconcileFunction,
        scheduledQuerySchedulerFunction,
        dbtSchedulerFunction,
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
  cdcScheduledBackfillFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  flowRunTerminalFanoutFunction,
  notificationDeliverFunction,
  syncBackfillEntityFunction,
  webhookRetryFunction,
  cdcMaterializeFunction,
  cdcMaterializeSchedulerFunction,
  dashboardRefreshFunction,
  dashboardSchedulerFunction,
  cleanupAbandonedMaterializationRunsFunction,
  appsBindingMaterializeFunction,
  appsBindingSchedulerFunction,
  usageReportingFunction,
  modelCatalogRefreshFunction,
  scheduledQueryExecutorFunction,
  scheduledQuerySchedulerFunction,
  dbtRunExecutorFunction,
  dbtRunCancelFunction,
  dbtSchedulerFunction,
  dbtRunSweeperFunction,
};
