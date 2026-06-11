import { IDatabaseConnection } from "../database/workspace-schema";
import { DatabaseDriver } from "./driver";
import { databaseRegistry } from "./registry";

export interface ConsoleTemplateNode {
  id?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Default console language + placeholder query for a database connection and
 * optional explorer-node context. Shared by the workspace API route and the
 * local agent so both return identical templates.
 */
export function buildConsoleTemplate(
  database: Pick<IDatabaseConnection, "type" | "connection">,
  node?: ConsoleTemplateNode,
): { language: string; template: string } {
  const driver = databaseRegistry.getDriver(database.type) as
    | (DatabaseDriver & { getMetadata: () => { consoleLanguage?: string } })
    | undefined;

  const dbType = database.type;
  const language =
    (driver?.getMetadata().consoleLanguage as string) ||
    (dbType === "mongodb" ? "mongodb" : "sql");

  const nodeId = node?.id;
  const nodeKind = node?.kind;
  const metadata = node?.metadata as
    | {
        datasetId?: string;
        table?: string;
        databaseName?: string;
        tableName?: string;
      }
    | undefined;

  let template = "";
  if (dbType === "mongodb") {
    const collectionName =
      nodeId && String(nodeKind) === "collection"
        ? String(nodeId)
        : "collection";
    template = `db.getCollection("${collectionName}").find({}).limit(500)`;
  } else if (dbType === "bigquery") {
    const projectId =
      (database.connection as { project_id?: string })?.project_id || "project";
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
  }
  // Postgres-family tables no longer use console templates: clicking a
  // table in the explorer opens a paginated data tab instead.

  return { language, template };
}
