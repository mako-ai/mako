import { z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { Flow, FlowExecution } from "../../database/workspace-schema";
import { inngest } from "../../inngest";
import {
  cancelFlowRuns,
  FlowCancelError,
} from "../../services/flow-cancel.service";
import { resolveLiveFlowRow } from "../../services/flow-sync.service";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  findFlow,
  flowRoute,
  logger,
  queryParam,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerRunsRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/:flowId/run - Manually trigger flow
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/run", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");

        // Resolve through the git overlay: a flow whose file was deleted on
        // main is not runnable, and one that exists only in git says so.
        const resolved = await resolveLiveFlowRow(String(workspaceId), flowId);
        if (!resolved.ok) {
          return fail(c, resolved.status, resolved.error);
        }
        const flow = await Flow.findById(resolved.row._id)
          .populate("dataSourceId")
          .populate("destinationDatabaseId");

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        // Trigger flow via Inngest
        const eventId = await inngest.send({
          name: "flow.manual",
          data: {
            flowId: flow._id.toString(),
          },
        });

        return c.json({
          success: true,
          message: "Flow triggered successfully",
          data: {
            flowId: flow._id,
            eventId,
            startedAt: new Date(),
          },
        });
      } catch (error) {
        logger.error("Error running flow", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // GET /api/workspaces/:workspaceId/flows/:flowId/status - Check if flow is running
  flowRoutes.openapi(flowRoute("get", "/{flowId}/status"), async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const flowId = c.req.param("flowId");

      // Verify flow exists and belongs to workspace
      const flow = await findFlow(workspaceId, flowId);

      if (!flow) {
        return fail(c, 404, "Flow not found");
      }

      // Check for running executions
      const runningExecution = await FlowExecution.findOne({
        flowId: new Types.ObjectId(flowId),
        workspaceId: new Types.ObjectId(workspaceId),
        status: "running",
      })
        .sort({ startedAt: -1 })
        .lean();

      return c.json({
        success: true,
        data: {
          isRunning: !!runningExecution,
          runningExecution: runningExecution
            ? {
                executionId: runningExecution._id,
                startedAt: runningExecution.startedAt,
                lastHeartbeat: runningExecution.lastHeartbeat,
              }
            : null,
        },
      });
    } catch (error) {
      logger.error("Error checking flow status", { error });
      return fail(c, 500, thrownMessage(error));
    }
  });

  // POST /api/workspaces/:workspaceId/flows/:flowId/cancel - Cancel running flow
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/cancel", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const body = await c.req.json().catch(() => ({}));
        const { executionId } = body;

        // Verify flow exists and belongs to workspace
        const flow = await findFlow(workspaceId, flowId);

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        // Same step as the MCP flow_cancel tool: the given execution, or
        // every running one (plus a running CDC backfill).
        const result = await cancelFlowRuns(
          String(workspaceId),
          flow,
          executionId,
        );
        const first = result.executions[0];

        return c.json({
          success: true,
          message: "Cancellation request sent successfully",
          data: {
            flowId: flow._id,
            executionId: first?.executionId ?? null,
            eventId: first?.eventId ?? null,
            executions: result.executions,
            backfill: result.backfill,
          },
        });
      } catch (error) {
        if (error instanceof FlowCancelError) {
          return fail(c, error.status, error.message);
        }
        logger.error("Error cancelling flow", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // GET /api/workspaces/:workspaceId/flows/:flowId/history - Get execution history
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/history", {
      query: z.object({
        limit: queryParam("limit"),
      }),
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const limit = parseInt(c.req.query("limit") || "50");
        const offset = parseInt(c.req.query("offset") || "0");

        // Verify flow exists and belongs to workspace
        const flow = await findFlow(workspaceId, flowId);

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        // Fetch executions from flow_executions collection
        const executions = await FlowExecution.find({
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        })
          .sort({ startedAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean();

        const formatted = executions.map(ex => ({
          executionId: ex._id,
          executedAt: ex.startedAt,
          status: ex.status,
          success: ex.success,
          error: ex.error,
          duration: ex.duration,
          logCount: Array.isArray(ex.logs) ? ex.logs.length : 0,
        }));

        return c.json({
          success: true,
          data: {
            total: await FlowExecution.countDocuments({
              flowId: new Types.ObjectId(flowId),
              workspaceId: new Types.ObjectId(workspaceId),
            }),
            limit,
            offset,
            history: formatted,
          },
        });
      } catch (error) {
        logger.error("Error getting flow history", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // GET full details for a specific execution
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/executions/{executionId}"),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const executionId = c.req.param("executionId");

        const execution = await FlowExecution.findOne({
          _id: new Types.ObjectId(executionId),
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).lean();

        if (!execution) {
          return fail(c, 404, "Execution not found");
        }

        return c.json({ success: true, data: execution });
      } catch (error) {
        logger.error("Error getting execution details", { error });
        return fail(c, 500, "Server error");
      }
    },
  );

  // GET logs for a specific execution
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/executions/{executionId}/logs"),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const executionId = c.req.param("executionId");

        const execution = await FlowExecution.findOne({
          _id: new Types.ObjectId(executionId),
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).lean();

        if (!execution) {
          return fail(c, 404, "Execution not found");
        }

        return c.json({ success: true, data: execution.logs || [] });
      } catch (error) {
        logger.error("Error getting execution logs", { error });
        return fail(c, 500, "Server error");
      }
    },
  );
}
