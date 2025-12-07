import { inngest } from "./client";
import {
  flowFunction,
  scheduledFlowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  // Backwards compatibility exports
  syncJobFunction,
  scheduledSyncJobFunction,
  manualSyncJobFunction,
  cancelSyncJobFunction,
  cleanupAbandonedJobsFunction,
} from "./functions/flow";
import {
  webhookEventProcessFunction,
  webhookCleanupFunction,
  webhookRetryFunction,
} from "./functions/webhook-job";

// Check if we're running in development mode
const isDevelopment =
  process.env.NODE_ENV !== "production" ||
  process.env.DISABLE_SCHEDULED_SYNC === "true";

// Base functions that should always be available
const baseFunctions = [
  flowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
  webhookEventProcessFunction,
  webhookCleanupFunction,
  webhookRetryFunction,
];

// Conditionally add scheduled flow function (only in production)
export const functions = isDevelopment
  ? baseFunctions
  : [...baseFunctions, scheduledFlowFunction];

if (isDevelopment) {
  console.log("⚠️  Scheduled flows are DISABLED in development mode");
} else {
  console.log("✅ Scheduled flows are ENABLED in production mode");
}

// Re-export for named imports
export { inngest };
export {
  flowFunction,
  scheduledFlowFunction,
  manualFlowFunction,
  cancelFlowFunction,
  cleanupAbandonedFlowsFunction,
};
// Backwards compatibility exports
export {
  syncJobFunction,
  scheduledSyncJobFunction,
  manualSyncJobFunction,
  cancelSyncJobFunction,
  cleanupAbandonedJobsFunction,
};
export {
  webhookEventProcessFunction,
  webhookCleanupFunction,
  webhookRetryFunction,
};
