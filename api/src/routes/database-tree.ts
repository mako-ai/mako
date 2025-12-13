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
    } else {
      // Fallback SQL-like template
      const table = nodeId || "table_name";
      template = `SELECT * FROM ${table} LIMIT 500;`;
    }

    return c.json({ success: true, data: { language, template } });
  },
);
