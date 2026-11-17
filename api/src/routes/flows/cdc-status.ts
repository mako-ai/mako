import { z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  SourceConnection,
} from "../../database/workspace-schema";
import {
  getFlowCdcStatus,
  getFlowSchemaHealth,
} from "../../services/flow-cdc-status.service";
import { getDestinationEntityRowCountsBatch } from "../../services/flow-destination-counts.service";
import { resolveConfiguredEntities } from "../../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { fail } from "../lib/respond";
import { flowFailure, flowRoute, queryParam, type FlowRouter } from "./shared";

export function registerCdcStatusRoutes(flowRoutes: FlowRouter): void {
  // GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/status
  // Unified CDC observability — 3 queries (Flow, CdcEntityState, recent transitions).
  // Replaces the old /summary (11 queries) and /diagnostics (500-event scan) endpoints.
  flowRoutes.openapi(flowRoute("get", "/{flowId}/sync-cdc/status"), async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const flowId = c.req.param("flowId") as string;
      return c.json({
        success: true,
        data: await getFlowCdcStatus(workspaceId, flowId),
      });
    } catch (error) {
      return flowFailure(c, error, 400);
    }
  });

  // GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/schema-health
  // Compare live destination column types against the connector schema to surface drift.
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/sync-cdc/schema-health", {
      query: z.object({
        entity: queryParam("entity"),
      }),
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const entityFilter = c.req.query("entity");
        return c.json({
          success: true,
          data: await getFlowSchemaHealth(workspaceId, flowId, entityFilter),
        });
      } catch (error) {
        return flowFailure(c, error, 400);
      }
    },
  );

  // GET /api/workspaces/:workspaceId/flows/:flowId/sync-cdc/destination-counts
  // Lazy endpoint — returns destination row counts per entity (may be slow for BigQuery).
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/sync-cdc/destination-counts"),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const workspaceObjectId = new Types.ObjectId(workspaceId);
        const flowObjectId = new Types.ObjectId(flowId);

        const flow = await Flow.findOne({
          _id: flowObjectId,
          workspaceId: workspaceObjectId,
        }).lean();

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        if (
          !flow.tableDestination?.connectionId ||
          !flow.tableDestination?.schema
        ) {
          return c.json({ success: true, data: {} });
        }

        const destinationDoc = await DatabaseConnection.findById(
          flow.tableDestination.connectionId,
        );
        const destination = destinationDoc?.toObject();
        if (!destination) {
          return c.json({ success: true, data: {} });
        }

        const { entities: configuredEntities } = resolveConfiguredEntities(
          flow as any,
        );
        const states = await CdcEntityState.find({
          workspaceId: workspaceObjectId,
          flowId: flowObjectId,
        })
          .select("entity")
          .lean();
        const uniqueEntities = Array.from(
          new Set([
            ...configuredEntities,
            ...states
              .map(s => (typeof s.entity === "string" ? s.entity : ""))
              .filter(Boolean),
          ]),
        );

        const data = await getDestinationEntityRowCountsBatch({
          workspaceId,
          flowId,
          entities: uniqueEntities,
          destinationType: destination.type,
          destination,
          schema: flow.tableDestination?.schema || "",
          baseTablePrefix: flow.tableDestination?.tableName,
        });

        return c.json({ success: true, data });
      } catch (error) {
        return flowFailure(c, error, 400);
      }
    },
  );

  // Backward-compat: /summary and /diagnostics redirect to unified /status
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/sync-cdc/summary"),
    async c => {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.replace("/summary", "/status");
      return c.redirect(url.toString(), 307);
    },
  );

  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/sync-cdc/diagnostics"),
    async c => {
      const url = new URL(c.req.url);
      url.pathname = url.pathname.replace("/diagnostics", "/status");
      return c.redirect(url.toString(), 307);
    },
  );

  // GET /api/workspaces/:workspaceId/flows/:flowId/schema?entity=activities:LeadStatusChange
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/schema", {
      query: z.object({
        entity: queryParam("entity"),
      }),
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const entity = c.req.query("entity");

        if (!entity) {
          return fail(c, 400, "entity query parameter is required");
        }

        const flow = await Flow.findOne({
          _id: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).lean();

        if (!flow) {
          return fail(c, 404, "Flow not found");
        }

        if (!flow.dataSourceId) {
          return fail(c, 400, "Flow has no connector data source");
        }

        const sourceConnection = await SourceConnection.findOne({
          _id: flow.dataSourceId,
          workspaceId: flow.workspaceId,
        }).lean();
        if (!sourceConnection) {
          return fail(c, 404, "Data source not found");
        }

        const decrypted = await sourceConnectionManager.getSourceConnection(
          String(sourceConnection._id),
          String(flow.workspaceId),
        );
        if (!decrypted) {
          return fail(c, 404, "Could not resolve data source");
        }
        const connector =
          await syncConnectorRegistry.getConnectorFor(decrypted);
        if (!connector) {
          return fail(c, 404, "Connector not found for data source type");
        }

        const schema = await connector.resolveSchema(entity);
        if (!schema) {
          return fail(c, 404, `No schema available for entity: ${entity}`);
        }

        return c.json({ success: true, data: schema });
      } catch (error) {
        return flowFailure(c, error, 400);
      }
    },
  );
}
