import { asSystem } from "../../access/connection-writes";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  assertOwnerOrAdmin,
  flowRoute,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerCdcStreamRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/recover", { body: ANY_JSON_BODY }),
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
          retryFailedMaterialization?: boolean;
          entity?: string;
        };
        // Drops the flow's own orphaned staging tables: Mako's, like its syncs.
        const result = await asSystem(() =>
          cdcBackfillService.recoverFlow({
            workspaceId,
            flowId,
            retryFailedMaterialization:
              body.retryFailedMaterialization !== false,
            entity: typeof body.entity === "string" ? body.entity : undefined,
          }),
        );
        return c.json({
          success: true,
          message: "CDC flow recovered",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-stream
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/recover-stream", {
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
          retryFailedMaterialization?: boolean;
          entity?: string;
        };
        // Drops the flow's own orphaned staging tables: Mako's, like its syncs.
        const result = await asSystem(() =>
          cdcBackfillService.recoverStream({
            workspaceId,
            flowId,
            retryFailedMaterialization:
              body.retryFailedMaterialization !== false,
            entity: typeof body.entity === "string" ? body.entity : undefined,
          }),
        );
        return c.json({
          success: true,
          message: "CDC stream recovered",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/recover-backfill
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/recover-backfill", {
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

        const result = await cdcBackfillService.startBackfill(
          workspaceId,
          flowId,
          {
            reuseExistingRunId: true,
            reason: "Backfill restarted via recover-backfill (from checkpoint)",
          },
        );
        return c.json({
          success: true,
          message: "CDC backfill recovered",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/reprocess-stale
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/reprocess-stale", {
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

        const result = await cdcBackfillService.reprocessStaleEvents({
          workspaceId,
          flowId,
        });
        return c.json({
          success: true,
          message: "Stale events reprocessed",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/materialize/retry-failed
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/materialize/retry-failed", {
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
        const result = await cdcBackfillService.retryFailedMaterialization({
          workspaceId,
          flowId,
          entity: typeof body.entity === "string" ? body.entity : undefined,
        });
        return c.json({
          success: true,
          message: "Queued failed CDC rows for materialization retry",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/start
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/stream/start", {
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
        const result = await cdcBackfillService.resumeStream(
          workspaceId,
          flowId,
        );
        return c.json({
          success: true,
          message: "CDC stream activated",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/stream/pause
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/stream/pause", {
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
        const result = await cdcBackfillService.pauseStream(
          workspaceId,
          flowId,
        );
        return c.json({
          success: true,
          message: "CDC stream paused",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/pause
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/pause", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;
        const result = await cdcBackfillService.pauseBackfill(
          workspaceId,
          flowId,
        );
        return c.json({
          success: true,
          message: "CDC flow paused",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/resume
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/sync-cdc/resume", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;
        const result = await cdcBackfillService.resumeBackfill(
          workspaceId,
          flowId,
        );
        return c.json({
          success: true,
          message: "CDC flow resumed",
          data: result,
        });
      } catch (error) {
        return fail(c, 400, thrownMessage(error));
      }
    },
  );
}
