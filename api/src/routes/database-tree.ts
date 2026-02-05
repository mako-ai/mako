import { Hono } from "hono";
import { authMiddleware } from "../auth/auth.middleware";
import {
  requireWorkspace,
  AuthenticatedContext,
} from "../middleware/workspace.middleware";
import { DatabaseConnection } from "../database/workspace-schema";
import { Types } from "mongoose";
import { databaseRegistry } from "../databases/registry";
import { DatabaseDriver } from "../databases/driver";
import { databaseConnectionService } from "../services/database-connection.service";
import { loggers } from "../logging";

export const databaseTreeRoutes = new Hono();

// GET /api/workspaces/:workspaceId/databases/:id/tree
databaseTreeRoutes.get(
  "/:id/tree",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
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
databaseTreeRoutes.get(
  "/:id/autocomplete",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
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
databaseTreeRoutes.get(
  "/:id/console-template",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
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

    const driver = databaseRegistry.getDriver(database.type) as
      | (DatabaseDriver & { getMetadata: () => { consoleLanguage?: string } })
      | undefined;
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }

    // Node context (optional)
    const nodeId = c.req.query("nodeId");
    const nodeKind = c.req.query("kind");
    const metadataRaw = c.req.query("metadata");
    const metadata = metadataRaw ? JSON.parse(String(metadataRaw)) : undefined;

    const dbType = database.type;
    const language =
      (driver.getMetadata().consoleLanguage as string) ||
      (dbType === "mongodb" ? "mongodb" : "sql");

    // Derive sensible default template by DB type and node info
    let template = "";
    if (dbType === "mongodb") {
      const collectionName =
        nodeId && String(nodeKind) === "collection"
          ? String(nodeId)
          : "collection";
      template = `db.getCollection("${collectionName}").find({}).limit(500)`;
    } else if (dbType === "bigquery") {
      const projectId = (database.connection as any)?.project_id || "project";
      const dataset =
        metadata?.datasetId ||
        (typeof nodeId === "string" && nodeId.includes(".")
          ? nodeId.split(".")[0]
          : "dataset");
      const table =
        typeof nodeId === "string" && nodeId.includes(".")
          ? nodeId.split(".")[1]
          : nodeId || "table_name";
      template = `SELECT * FROM \`${projectId}.${dataset}.${table}\` LIMIT 500;`;
    } else if (dbType === "cloudflare-d1") {
      // D1 is SQLite-based
      const table =
        metadata?.table ||
        (typeof nodeId === "string" && nodeId.includes(".")
          ? nodeId.split(".")[1]
          : nodeId || "table_name");
      template = `SELECT * FROM ${table} LIMIT 500;`;
    } else if (dbType === "cloudflare-kv") {
      // KV uses JavaScript-like syntax mirroring Cloudflare Workers API
      template = "kv.list({ limit: 100 })";
    } else if (dbType === "clickhouse") {
      // ClickHouse uses database.table format
      const dbName = metadata?.databaseName || "default";
      const table = metadata?.tableName || nodeId || "table_name";
      template = `SELECT * FROM "${dbName}"."${table}" LIMIT 500;`;
    } else {
      // Fallback SQL-like template
      const table = nodeId || "table_name";
      template = `SELECT * FROM ${table} LIMIT 500;`;
    }

    return c.json({ success: true, data: { language, template } });
  },
);

// GET /api/workspaces/:workspaceId/databases/:id/table-exists
// Check if a table exists and return its schema if it does
databaseTreeRoutes.get(
  "/:id/table-exists",
  authMiddleware,
  requireWorkspace,
  async (c: AuthenticatedContext) => {
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
        return c.json({
          success: false,
          error: "schema (dataset) is required for BigQuery",
        }, 400);
      }

      // For PostgreSQL, default to public schema
      if (dbConnection.type === "postgresql" && !options.schema) {
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
      let columns: Array<{ name: string; type: string; nullable?: boolean }> = [];

      if (dbConnection.type === "postgresql") {
        // Query PostgreSQL information_schema for columns
        const schemaName = options.schema || "public";
        const columnQuery = `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = '${schemaName.replace(/'/g, "''")}'
            AND table_name = '${String(tableName).replace(/'/g, "''")}'
          ORDER BY ordinal_position;
        `;
        const result = await driver.executeQuery(dbConnection as any, columnQuery);
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
          const result = await driver.executeQuery(dbConnection as any, columnQuery);
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
