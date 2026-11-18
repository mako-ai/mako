import { z } from "@hono/zod-openapi";
import { RepoRequiredError } from "../../apps/config";
import { fail } from "../lib/respond";
import { resyncLastRunAt } from "../../services/resync-schedule";
import {
  ANY_JSON_BODY,
  assertFlowRepo,
  assertOwnerOrAdmin,
  commitFlowFileOrFail,
  findFlow,
  flowRoute,
  logger,
  repoRequired,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerSettingsRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/:flowId/toggle - Enable/disable flow
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/toggle", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        if (!workspaceId) {
          return fail(c, 400, "Workspace ID is required");
        }
        // Enabling or disabling is a definition change — it rewrites
        // `flows/<slug>.yml` (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);

        const flow = await findFlow(workspaceId, flowId);

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        // Unified trigger model: any flow may carry a poll schedule (hybrid
        // webhook + schedule), so no type gate here.
        if (!flow.schedule?.cron) {
          flow.schedule = {
            enabled: true,
            cron: "0 * * * *",
            timezone: "UTC",
          } as any;
        } else {
          flow.schedule.enabled = !flow.schedule.enabled;
        }
        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();

        return c.json({
          success: true,
          data: {
            enabled: flow.schedule?.enabled ?? false,
            message: `Schedule ${flow.schedule?.enabled ? "enabled" : "disabled"} successfully`,
          },
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        logger.error("Error toggling flow", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-engine
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-engine", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(c, workspaceId);
        if (authorizationError) return authorizationError;
        // Sync engine and backfill cadence are both serialized into
        // `flows/<slug>.yml` (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);

        const body = await c.req.json();
        const syncEngine = body?.syncEngine;
        // CDC is the only engine: the legacy engine has been removed.
        if (syncEngine !== "cdc") {
          return fail(
            c,
            400,
            "syncEngine must be 'cdc': the legacy sync engine has been removed",
          );
        }

        const flow = await findFlow(workspaceId, flowId);
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        flow.syncEngine = syncEngine;
        flow.streamState = flow.streamState || "idle";
        flow.syncStateUpdatedAt = new Date();
        flow.syncStateMeta = {
          lastEvent: "ENGINE_SWITCH",
          lastReason: "Switched to cdc engine",
        };
        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();

        return c.json({
          success: true,
          data: {
            flowId: flow._id,
            syncEngine: flow.syncEngine,
            syncState: flow.syncState,
          },
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        logger.error("Error updating sync engine", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/backfill-schedule
  // Configure (or disable) a periodic full backfill cadence for a CDC flow.
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/backfill-schedule", {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean(),
              cron: z.string().optional(),
              timezone: z.string().optional(),
            }),
          },
        },
      },
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(c, workspaceId);
        if (authorizationError) return authorizationError;
        // Sync engine and backfill cadence are both serialized into
        // `flows/<slug>.yml` (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);

        const body = await c.req.json();
        const enabled = Boolean(body?.enabled);
        const cron = typeof body?.cron === "string" ? body.cron.trim() : "";
        const timezone =
          typeof body?.timezone === "string" && body.timezone.trim().length > 0
            ? body.timezone.trim()
            : "UTC";

        if (enabled) {
          const fields = cron.split(" ").filter(Boolean);
          if (fields.length !== 5 && fields.length !== 6) {
            return fail(
              c,
              400,
              "A valid cron expression is required to enable a schedule",
            );
          }
        }

        const flow = await findFlow(workspaceId, flowId);
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }
        if (flow.syncEngine !== "cdc") {
          return fail(c, 400, "Scheduled backfill requires syncEngine=cdc");
        }

        const next = {
          enabled,
          cron: enabled ? cron : flow.backfillSchedule?.cron,
          timezone,
        };
        flow.backfillSchedule = {
          ...next,
          entities: flow.backfillSchedule?.entities,
          // A new or changed resync first runs at its next tick.
          lastRunAt: resyncLastRunAt(flow.backfillSchedule, next),
        };
        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();

        return c.json({
          success: true,
          data: {
            flowId: flow._id,
            backfillSchedule: flow.backfillSchedule,
          },
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        logger.error("Error updating backfill schedule", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );
}
