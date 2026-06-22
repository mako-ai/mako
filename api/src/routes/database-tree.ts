import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireWorkspace } from "../middleware/workspace.middleware";
import { DatabaseConnection } from "../database/workspace-schema";
import { Types } from "mongoose";
import { databaseRegistry } from "../databases/registry";
import { databaseConnectionService } from "../services/database-connection.service";
import { buildConsoleTemplate } from "../databases/console-template";
import { loggers } from "../logging";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

export const databaseTreeRoutes = createRouter();

databaseTreeRoutes.use("*", unifiedAuthMiddleware);
databaseTreeRoutes.use("*", requireWorkspace);

const DbIdParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

// GET /api/workspaces/:workspaceId/databases/:id/tree
databaseTreeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/tree",
    tags: ["Databases"],
    summary: "Get database object tree",
    security: AUTH_SECURITY,
    request: {
      params: DbIdParam,
      query: z.object({
        nodeId: z.string().optional(),
        kind: z.string().optional(),
        metadata: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }
    const driver = databaseRegistry.getDriver(database.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }
    const nodeId = c.req.query("nodeId");
    const nodeKind = c.req.query("kind");
    const metadataRaw = c.req.query("metadata");
    if (!nodeId) {
      const nodes = await driver.getTreeRoot(database as any);
      return c.json({ success: true, data: nodes });
    }
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : undefined;
    const nodes = await driver.getChildren(database as any, {
      id: String(nodeId),
      kind: String(nodeKind || ""),
      metadata,
    });
    return c.json({ success: true, data: nodes });
  },
);

// GET /api/workspaces/:workspaceId/databases/:id/autocomplete
databaseTreeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/autocomplete",
    tags: ["Databases"],
    summary: "Get autocomplete data",
    security: AUTH_SECURITY,
    request: {
      params: DbIdParam,
      query: z.object({
        datasetId: z.string().optional(),
        tableId: z.string().optional(),
        prefix: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }
    const driver = databaseRegistry.getDriver(database.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }

    // BigQuery: incremental autocomplete to avoid fetching full schema
    if (database.type === "bigquery") {
      const datasetIdRaw = c.req.query("datasetId");
      const tableIdRaw = c.req.query("tableId");
      const prefix = String(c.req.query("prefix") || "");
      const limitRaw = String(c.req.query("limit") || "100");
      const limit = Math.max(
        1,
        Math.min(200, Number.parseInt(limitRaw, 10) || 100),
      );

      const datasetId = datasetIdRaw ? String(datasetIdRaw) : undefined;
      const tableId = tableIdRaw ? String(tableIdRaw) : undefined;

      // Basic validation for BigQuery identifiers.
      // - Dataset IDs: letters, numbers, underscores (no hyphens)
      // - Table IDs: letters, numbers, underscores, hyphens
      const isValidDatasetId = (v: string) => /^[A-Za-z0-9_]+$/.test(v);
      const isValidTableId = (v: string) => /^[A-Za-z0-9_-]+$/.test(v);
      if (datasetId && !isValidDatasetId(datasetId)) {
        return c.json({ success: false, error: "Invalid datasetId" }, 400);
      }
      if (tableId && !isValidTableId(tableId)) {
        return c.json({ success: false, error: "Invalid tableId" }, 400);
      }

      try {
        // 1) Datasets
        if (!datasetId) {
          const filtered =
            await databaseConnectionService.listBigQueryDatasetsForAutocomplete(
              database as any,
              { prefix, limit },
            );
          return c.json({
            success: true,
            data: { kind: "datasets", datasets: filtered },
          });
        }

        // 2) Tables for a dataset
        if (!tableId) {
          const filtered =
            await databaseConnectionService.listBigQueryTableIdsForAutocomplete(
              database as any,
              datasetId,
              { prefix, limit },
            );
          return c.json({
            success: true,
            data: { kind: "tables", datasetId, tables: filtered },
          });
        }

        // 3) Columns for a table
        const columns = await databaseConnectionService.getBigQueryTableColumns(
          database as any,
          datasetId,
          tableId,
        );
        const filtered = columns
          .filter(c => (prefix ? c.name.startsWith(prefix) : true))
          .slice(0, limit);
        return c.json({
          success: true,
          data: { kind: "columns", datasetId, tableId, columns: filtered },
        });
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to fetch BigQuery autocomplete data",
          },
          500,
        );
      }
    }

    if (!driver.getAutocompleteData) {
      return c.json(
        {
          success: false,
          error: "Autocomplete not supported for this database type",
        },
        400,
      );
    }

    try {
      const schema = await driver.getAutocompleteData(database as any);
      return c.json({ success: true, data: schema });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch autocomplete data",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/databases/:id/console-template
// Returns a placeholder query and language for a given database and optional node context
databaseTreeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/console-template",
    tags: ["Databases"],
    summary: "Get a console template for a database",
    security: AUTH_SECURITY,
    request: {
      params: DbIdParam,
      query: z.object({
        nodeId: z.string().optional(),
        kind: z.string().optional(),
        metadata: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }

    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }

    const driver = databaseRegistry.getDriver(database.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }

    // Node context (optional)
    const nodeId = c.req.query("nodeId");
    const nodeKind = c.req.query("kind");
    const metadataRaw = c.req.query("metadata");
    const metadata = metadataRaw ? JSON.parse(String(metadataRaw)) : undefined;

    const data = buildConsoleTemplate(database, {
      id: nodeId ? String(nodeId) : undefined,
      kind: nodeKind ? String(nodeKind) : undefined,
      metadata,
    });

    return c.json({ success: true, data });
  },
);

// GET /api/workspaces/:workspaceId/databases/:id/table-definition
// Full SQL definition script (DDL, comments, indexes, triggers) for one
// table or view. Currently Postgres-family only.
databaseTreeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/table-definition",
    tags: ["Databases"],
    summary: "Get a table's SQL definition",
    security: AUTH_SECURITY,
    request: {
      params: DbIdParam,
      query: z.object({
        table: z.string().optional(),
        schema: z.string().optional(),
        database: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const log = loggers.api("database-tree");
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }

    const table = c.req.query("table");
    if (!table) {
      return c.json({ success: false, error: "table is required" }, 400);
    }
    const schema = String(c.req.query("schema") || "public");
    const databaseName = c.req.query("database");

    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }

    const driver = databaseRegistry.getDriver(database.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }
    if (!driver.getTableDefinition) {
      return c.json(
        {
          success: false,
          error: `Table definition not supported for ${database.type}`,
        },
        400,
      );
    }

    try {
      const result = await driver.getTableDefinition(database as any, {
        schema,
        table: String(table),
        databaseName: databaseName ? String(databaseName) : undefined,
      });
      if (!result.success) {
        return c.json(
          {
            success: false,
            error: result.error || "Failed to fetch table definition",
          },
          500,
        );
      }
      return c.json({
        success: true,
        data: { definition: result.definition },
      });
    } catch (error) {
      log.error("Error fetching table definition", {
        error,
        schema,
        table,
        databaseType: database.type,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch table definition",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/databases/:id/table-exists
// Check if a table exists and return its schema if it does
databaseTreeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/table-exists",
    tags: ["Databases"],
    summary: "Check whether a table exists",
    security: AUTH_SECURITY,
    request: {
      params: DbIdParam,
      query: z.object({
        tableName: z.string().optional(),
        schema: z.string().optional(),
        database: z.string().optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const log = loggers.api("database-tree");
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    const tableName = c.req.query("tableName");
    const schema = c.req.query("schema"); // For PostgreSQL (default: public)
    const database = c.req.query("database"); // For database selection (optional)

    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }

    if (!tableName) {
      return c.json({ success: false, error: "tableName is required" }, 400);
    }

    const dbConnection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });

    if (!dbConnection) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }

    const driver = databaseRegistry.getDriver(dbConnection.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }

    // Check if driver supports tableExists
    if (!driver.tableExists) {
      return c.json({
        success: true,
        data: {
          exists: false,
          supported: false,
          message: `Table existence check not supported for ${dbConnection.type}`,
        },
      });
    }

    try {
      // Build options based on database type
      const options: { schema?: string; database?: string } = {};
      if (schema) options.schema = String(schema);
      if (database) options.database = String(database);

      // For BigQuery, schema is actually the dataset
      if (dbConnection.type === "bigquery" && !options.schema) {
        return c.json(
          {
            success: false,
            error: "schema (dataset) is required for BigQuery",
          },
          400,
        );
      }

      // For PostgreSQL/Redshift, default to public schema
      if (
        (dbConnection.type === "postgresql" ||
          dbConnection.type === "redshift") &&
        !options.schema
      ) {
        options.schema = "public";
      }

      const exists = await driver.tableExists(
        dbConnection as any,
        String(tableName),
        options,
      );

      if (!exists) {
        return c.json({
          success: true,
          data: { exists: false, columns: [] },
        });
      }

      // Table exists - try to get column information
      let columns: Array<{ name: string; type: string; nullable?: boolean }> =
        [];

      if (
        dbConnection.type === "postgresql" ||
        dbConnection.type === "redshift"
      ) {
        // Query PostgreSQL/Redshift information_schema for columns
        const schemaName = options.schema || "public";
        const columnQuery = `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = '${schemaName.replace(/'/g, "''")}'
            AND table_name = '${String(tableName).replace(/'/g, "''")}'
          ORDER BY ordinal_position;
        `;
        const result = await driver.executeQuery(
          dbConnection as any,
          columnQuery,
        );
        if (result.success && result.data) {
          columns = result.data.map((row: any) => ({
            name: row.column_name,
            type: row.data_type?.toUpperCase() || "UNKNOWN",
            nullable: row.is_nullable === "YES",
          }));
        }
      } else if (dbConnection.type === "bigquery") {
        // Query BigQuery INFORMATION_SCHEMA for columns
        const projectId = (dbConnection.connection as any)?.project_id;
        const dataset = options.schema;
        if (projectId && dataset) {
          const columnQuery = `
            SELECT column_name, data_type, is_nullable
            FROM \`${projectId}\`.\`${dataset}\`.INFORMATION_SCHEMA.COLUMNS
            WHERE table_name = '${String(tableName).replace(/'/g, "\\'")}'
            ORDER BY ordinal_position;
          `;
          const result = await driver.executeQuery(
            dbConnection as any,
            columnQuery,
          );
          if (result.success && result.data) {
            columns = result.data.map((row: any) => ({
              name: row.column_name,
              type: row.data_type || "UNKNOWN",
              nullable: row.is_nullable === "YES",
            }));
          }
        }
      }

      log.info("Table existence check completed", {
        tableName,
        exists,
        columnCount: columns.length,
        databaseType: dbConnection.type,
      });

      return c.json({
        success: true,
        data: { exists: true, columns },
      });
    } catch (error) {
      log.error("Error checking table existence", {
        error,
        tableName,
        databaseType: dbConnection.type,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to check table existence",
        },
        500,
      );
    }
  },
);
