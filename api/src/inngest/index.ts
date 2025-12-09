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
  webhookCleanupFunction,
  webhookRetryFunction,
} from "./functions/webhook-flow";

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

// Conditionally add flow scheduler (only in production)
export const functions = isDevelopment
  ? baseFunctions
  : [...baseFunctions, flowSchedulerFunction];

if (isDevelopment) {
  console.log("⚠️  Scheduled flows are DISABLED in development mode");
} else {
  console.log("✅ Scheduled flows are ENABLED in production mode");
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
  webhookCleanupFunction,
  webhookRetryFunction,
};
