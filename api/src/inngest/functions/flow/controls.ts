import { inngest } from "../../client";
import { Flow } from "../../../database/workspace-schema";
import { Types } from "mongoose";

// Manual trigger function for immediate execution
export const manualFlowFunction = inngest.createFunction(
  {
    id: "manual-flow",
    name: "Manual Flow Trigger",
    triggers: { event: "flow.manual" },
  },
  async ({ event, step }) => {
    const { flowId } = event.data;

    // Trigger the flow with noJitter flag
    await step.sendEvent("trigger-flow", {
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true, // Skip jitter for manual execution
        triggerType: "manual",
      },
    });

    return { success: true, message: `Triggered flow: ${flowId}` };
  },
);

// Cancel running flow function - updates the database when cancel is requested
export const cancelFlowFunction = inngest.createFunction(
  {
    id: "cancel-flow",
    name: "Cancel Running Flow",
    triggers: { event: "flow.cancel" },
  },
  async ({ event, logger }) => {
    const { flowId, executionId } = event.data;

    logger.info("Processing cancel request", {
      flowId,
      executionId,
    });

    // Update the execution status to cancelled
    // Inngest will stop the function between steps, but we need to update the DB
    try {
      const db = Flow.db;
      const collection = db.collection("flow_executions");

      if (executionId) {
        const result = await collection.updateOne(
          {
            _id: new Types.ObjectId(executionId),
            status: "running", // Only update if still running
          },
          {
            $set: {
              completedAt: new Date(),
              lastHeartbeat: new Date(),
              status: "cancelled",
              success: false,
              error: {
                message: "Flow execution cancelled by user",
                code: "USER_CANCELLED",
              },
            },
          },
        );

        logger.info("Database update result", {
          flowId,
          executionId,
          modified: result.modifiedCount,
        });
      }
    } catch (error) {
      logger.error("Failed to update execution status", {
        flowId,
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      success: true,
      message: "Cancel request processed",
    };
  },
);
