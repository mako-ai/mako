import { Types } from "mongoose";
import { asSystem } from "../../access/connection-writes";
import { Flow } from "../../database/workspace-schema";
import { inngest } from "../../inngest";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { isSafeSqlIdentifier } from "../../services/flow-column-reset-sql";
import {
  resetFlowColumn,
  resetFlowEntity,
} from "../../services/flow-entity-reset.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  assertOwnerOrAdmin,
  findFlow,
  flowFailure,
  flowRoute,
  logger,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerCdcBackfillRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/:flowId/backfill - Trigger a full backfill
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/backfill", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;

        const flow = await findFlow(workspaceId, flowId);

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        if (flow.syncEngine === "cdc") {
          const backfill = await cdcBackfillService.startBackfill(
            workspaceId,
            flowId,
          );
          return c.json({
            success: true,
            message: "CDC backfill started",
            data: {
              flowId: flow._id,
              startedAt: new Date(),
              runId: backfill.runId,
              resumed: backfill.reusedRunId,
            },
          });
        }

        const eventId = await inngest.send({
          name: "flow.execute",
          data: {
            flowId: flow._id.toString(),
            noJitter: true,
            backfill: true,
            triggerType: "manual",
          },
        });

        logger.info("Backfill triggered", { flowId, eventId });

        return c.json({
          success: true,
          message: "Backfill started",
          data: {
            flowId: flow._id,
            eventId,
            startedAt: new Date(),
          },
        });
      } catch (error) {
        logger.error("Error triggering backfill", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/start
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/backfill/start", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;
        const body = (await c.req.json().catch(() => ({}))) as {
          entities?: string[];
        };
        const backfill = await cdcBackfillService.startBackfill(
          workspaceId,
          flowId,
          { entities: body.entities },
        );
        return c.json({
          success: true,
          message: "CDC backfill started",
          data: {
            runId: backfill.runId,
            resumed: backfill.reusedRunId,
          },
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/backfill/cancel
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/backfill/cancel", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;

        const result = await cdcBackfillService.cancelBackfill(
          workspaceId,
          flowId,
        );

        return c.json({
          success: true,
          message: "Backfill cancelled",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-entity
  // Drop destination table for one entity, clear its CDC state, and start a fresh backfill.
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/reset-entity", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;

        const body = (await c.req.json().catch(() => ({}))) as {
          entity?: string;
        };
        const entity =
          typeof body.entity === "string" ? body.entity.trim() : undefined;
        if (!entity) {
          return fail(c, 400, "entity is required");
        }

        const flow = await findFlow(workspaceId, flowId);
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        const backfill = await resetFlowEntity({
          workspaceId,
          flowId,
          flow,
          entity,
        });

        return c.json({
          success: true,
          message: "Entity table reset and backfill started",
          data: {
            entity,
            runId: backfill.runId,
          },
        });
      } catch (error) {
        return flowFailure(c, error, 400);
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reset-column
  // Reset one destination column for an entity and optionally start entity backfill.
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/reset-column", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;

        const body = (await c.req.json().catch(() => ({}))) as {
          entity?: string;
          column?: string;
          forceReplay?: boolean;
          startBackfill?: boolean;
        };
        const entity =
          typeof body.entity === "string" ? body.entity.trim() : undefined;
        const column =
          typeof body.column === "string" ? body.column.trim() : undefined;
        const forceReplay = body.forceReplay !== false;
        const startBackfill = body.startBackfill !== false;

        if (!entity) {
          return fail(c, 400, "entity is required");
        }
        if (!column) {
          return fail(c, 400, "column is required");
        }
        if (!isSafeSqlIdentifier(column)) {
          return fail(
            c,
            400,
            "column must be a valid SQL identifier (letters, digits, underscore)",
          );
        }

        const flow = await Flow.findOne({
          _id: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).lean();
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        const data = await resetFlowColumn({
          workspaceId,
          flowId,
          flow,
          entity,
          column,
          forceReplay,
          startBackfill,
        });

        return c.json({
          success: true,
          message: startBackfill
            ? "Column reset applied and entity backfill started"
            : "Column reset applied",
          data,
        });
      } catch (error) {
        return flowFailure(c, error, 400);
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resync
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/resync", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;
        const body = await c.req.json().catch(() => ({}));
        const entities = Array.isArray(body.entities)
          ? (body.entities as unknown[]).filter(
              (e): e is string => typeof e === "string" && e.length > 0,
            )
          : [];

        if (entities.length > 0) {
          // Scoped resync: only recreate/re-backfill the listed entities.
          await cdcBackfillService.resyncEntities({
            workspaceId,
            flowId,
            entities,
            deleteDestination: Boolean(body.deleteDestination),
          });
          return c.json({
            success: true,
            message: `CDC resync started for ${entities.length} entit${entities.length === 1 ? "y" : "ies"}`,
          });
        }

        // May drop the flow's own destination tables: Mako's, like its syncs.
        await asSystem(() =>
          cdcBackfillService.resyncFlow({
            workspaceId,
            flowId,
            deleteDestination: Boolean(body.deleteDestination),
            clearWebhookEvents: Boolean(body.clearWebhookEvents),
          }),
        );
        return c.json({
          success: true,
          message: "CDC resync started",
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );
}
