/** The entities (streams/objects) a source connection's connector offers. */
import { createRoute } from "@hono/zod-openapi";
import { connectionsRepo } from "../../repositories/connections";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { SourceIdParam, isSourceConnectionId } from "./shared";
import { fail, failFromThrown } from "../lib/respond";

export const sourceConnectionEntityRoutes = createRouter();

sourceConnectionEntityRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/entities",
    tags: ["Source Connections"],
    summary: "List entities for a source connection",
    security: AUTH_SECURITY,
    request: { params: SourceIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!isSourceConnectionId(id)) {
        return fail(c, 400, "Invalid source connection ID format");
      }

      // First, verify the source connection belongs to the workspace
      const ownershipCheck = await connectionsRepo.findSourceConnectionById(
        id,
        workspaceId,
      );
      if (!ownershipCheck) {
        return fail(c, 404, "Source connection not found in this workspace");
      }

      // Now get the full config using the manager
      const sourceConnection =
        await sourceConnectionManager.getSourceConnection(id, workspaceId);

      if (!sourceConnection) {
        return fail(c, 404, "Source connection not found");
      }

      // Get connector and its entities
      const connector =
        await syncConnectorRegistry.getConnectorFor(sourceConnection);
      if (!connector) {
        return fail(
          c,
          500,
          `No connector available for type: ${sourceConnection.type}`,
        );
      }

      // Try to get structured metadata first, fallback to flat list
      let entityData: any[];
      if (typeof connector.getEntityMetadata === "function") {
        // Return structured metadata if available
        entityData = connector.getEntityMetadata();
      } else {
        // Fallback to flat list for backward compatibility
        const entities = connector.getAvailableEntities();
        entityData = entities.map((entity: string) => ({
          name: entity,
          label: entity.charAt(0).toUpperCase() + entity.slice(1),
        }));
      }

      // Static, no-I/O — safe to compute once and reuse per entity below.
      const incrementalCapabilities =
        typeof connector.getIncrementalCapabilities === "function"
          ? connector.getIncrementalCapabilities()
          : undefined;

      // Enrich each entity (and sub-entity) with its field list, dedup key
      // columns, and incremental-pull capability from the connector schema,
      // so the UI can build schema-driven partition/cluster selectors (see
      // 15-connector-agnostic.mdc) and show Airbyte-style per-entity primary
      // key + incremental indicators instead of only a connector-level one.
      // Sub-entities are resolved with the flattened `parent:Sub` key used
      // elsewhere in the pipeline.
      const attachFields = async (node: any, schemaKey: string) => {
        try {
          const schema = await connector.resolveSchema(schemaKey);
          if (schema?.fields) {
            node.fields = Object.entries(schema.fields).map(
              ([name, field]) => ({ name, type: field.type }),
            );
          }
          // Mirrors the CDC layout fallback in buildCdcEntityLayout — when a
          // connector doesn't declare keyColumns, the pipeline dedups on
          // ["id"], so reflect that here rather than showing nothing.
          node.keyColumns =
            schema?.keyColumns && schema.keyColumns.length > 0
              ? schema.keyColumns
              : ["id"];
        } catch {
          // Skip entities where schema resolution fails; the UI falls back
          // to system fields only.
          node.keyColumns = ["id"];
        }
        if (incrementalCapabilities) {
          node.incrementalMode =
            incrementalCapabilities.perEntity?.[schemaKey]?.mode ??
            incrementalCapabilities.mode;
        }
      };

      try {
        await Promise.all(
          entityData.flatMap((node: any) => {
            const subs = Array.isArray(node.subEntities)
              ? node.subEntities
              : [];
            if (subs.length > 0) {
              return subs.map((sub: any) =>
                attachFields(sub, `${node.name}:${sub.name}`),
              );
            }
            return [attachFields(node, node.name)];
          }),
        );
      } catch {
        // Never fail the entities endpoint because of schema enrichment.
      }

      return c.json({
        success: true,
        data: entityData,
      });
    } catch (error) {
      return failFromThrown(c, error, "Unknown error");
    }
  },
);
