import type { IDatabaseConnection } from "../../database/workspace-schema";
import { connectionsRepo } from "../../repositories/connections";
import {
  checkQuerySafety,
  dryRunDbSync,
  validateQuery,
} from "../../services/destination-writer.service";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  flowRoute,
  logger,
  thrownMessage,
  type FlowRouter,
} from "./shared";

export function registerValidationRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/validate-query - Validate a database query before creating a flow
  flowRoutes.openapi(
    flowRoute("post", "/validate-query", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const body = await c.req.json();

        const { connectionId, query, database } = body;

        if (!connectionId) {
          return fail(c, 400, "connectionId is required");
        }

        if (!query) {
          return fail(c, 400, "query is required");
        }

        // Run safety checks first
        const safetyCheck = checkQuerySafety(query);
        if (!safetyCheck.safe) {
          return fail(c, 400, safetyCheck.errors.join("; "), { safetyCheck });
        }

        // Validate connection exists and belongs to workspace
        const connection = await connectionsRepo.findDatabaseConnectionById(
          String(connectionId),
          workspaceId,
        );

        if (!connection) {
          return fail(c, 404, "Database connection not found");
        }

        // Validate the query
        const result = await validateQuery(
          connection as unknown as IDatabaseConnection,
          query,
          database,
        );

        if (!result.success) {
          return fail(c, 400, result.error || "Query validation failed", {
            safetyCheck,
          });
        }

        return c.json({
          success: true,
          data: {
            columns: result.columns,
            sampleRow: result.sampleRow,
            connectionName: connection.name,
            connectionType: connection.type,
            safetyCheck,
          },
        });
      } catch (error) {
        logger.error("Error validating query", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );

  // POST /api/workspaces/:workspaceId/flows/dry-run - Dry run a sync configuration
  flowRoutes.openapi(
    flowRoute("post", "/dry-run", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const body = await c.req.json();

        const {
          connectionId,
          query,
          database,
          paginationConfig,
          typeCoercions,
          pageSize = 100,
          pages = 3,
        } = body;

        if (!connectionId) {
          return fail(c, 400, "connectionId is required");
        }

        if (!query) {
          return fail(c, 400, "query is required");
        }

        // Validate connection exists and belongs to workspace
        const connection = await connectionsRepo.findDatabaseConnectionById(
          String(connectionId),
          workspaceId,
        );

        if (!connection) {
          return fail(c, 404, "Database connection not found");
        }

        // Run dry run
        const result = await dryRunDbSync({
          sourceConnection: connection as unknown as IDatabaseConnection,
          sourceQuery: query,
          sourceDatabase: database,
          paginationConfig,
          typeCoercions,
          pageSize: Math.min(pageSize, 1000), // Cap at 1000 per page
          pages: Math.min(pages, 5), // Cap at 5 pages
        });

        if (!result.success) {
          // `error` can be absent on a failed driver result, so this body
          // keeps its historical shape rather than going through `fail`.
          return c.json(
            {
              success: false,
              error: result.error,
              safetyCheck: result.safetyCheck,
            },
            400,
          );
        }

        return c.json({
          success: true,
          data: {
            totalRows: result.totalRows,
            sampleData: result.sampleData,
            columns: result.columns,
            estimatedTotal: result.estimatedTotal,
            safetyCheck: result.safetyCheck,
            connectionName: connection.name,
            connectionType: connection.type,
          },
        });
      } catch (error) {
        logger.error("Error running dry-run", { error });
        return fail(c, 500, thrownMessage(error));
      }
    },
  );
}
