/**
 * BigQuery Tools for Agent V2
 * Using Vercel AI SDK's tool() function
 */

import { tool, Tool } from "ai";
import { z } from "zod";

// Type helper for creating tools - works around AI SDK type inference issues
type AnyTool = Tool<any, any>;
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import type { ConsoleDataV2 } from "../types";
import { createConsoleToolsV2 } from "./console-tools";

const appendLimitIfMissing = (sql: string): string => {
  const hasLimit = /\blimit\s+\d+\b/i.test(sql);
  if (hasLimit) return sql;
  const trimmed = sql.replace(/;\s*$/i, "");
  return `${trimmed}\nLIMIT 500;`;
};

const buildInspectTableSql = (
  projectId: string,
  datasetId: string,
  tableId: string,
) =>
  "SELECT column_name, data_type, is_nullable, ordinal_position\n" +
  `FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`\n` +
  `WHERE table_name = '${tableId}'\n` +
  "ORDER BY ordinal_position\n" +
  "LIMIT 1000";

// Helper functions for implementations
async function listBigQueryConnectionsImpl(workspaceId: string) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).sort({ name: 1 });

  return databases
    .filter(db => db.type === "bigquery")
    .map(db => {
      const conn = (
        db as unknown as { connection?: { project_id?: string } }
      ).connection || {};
      const projectId = conn.project_id || "unknown-project";
      return {
        id: db._id.toString(),
        name: db.name,
        description: "",
        project: projectId,
        type: db.type,
        active: true,
        displayName: `BigQuery (${projectId})`,
      };
    });
}

async function listDatasetsImpl(connectionId: string, workspaceId: string) {
  if (
    typeof connectionId !== "string" ||
    connectionId.trim().length === 0 ||
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error(
      "'connectionId' is required and must be a valid identifier",
    );
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) {
    throw new Error("Connection not found or access denied");
  }
  if (database.type !== "bigquery") {
    throw new Error("list_datasets only supports BigQuery connections");
  }
  const datasets = await databaseConnectionService.listBigQueryDatasets(
    database as Parameters<
      typeof databaseConnectionService.listBigQueryDatasets
    >[0],
  );
  return datasets.map(ds => ({ datasetId: ds }));
}

async function listTablesImpl(
  connectionId: string,
  datasetId: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) {
    throw new Error("Connection not found or access denied");
  }
  if (database.type !== "bigquery") {
    throw new Error("list_tables only supports BigQuery connections");
  }
  const items = await databaseConnectionService.listBigQueryTables(
    database as Parameters<
      typeof databaseConnectionService.listBigQueryTables
    >[0],
    datasetId,
  );
  return items.map(it => ({ name: it.name, type: it.type }));
}

async function inspectTableImpl(
  connectionId: string,
  datasetId: string,
  tableId: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) {
    throw new Error("Connection not found or access denied");
  }
  if (database.type !== "bigquery") {
    throw new Error("inspect_table only supports BigQuery connections");
  }
  const projectId = (
    database as unknown as { connection?: { project_id?: string } }
  ).connection?.project_id;
  if (!projectId) throw new Error("BigQuery connection missing project_id");
  const sql = buildInspectTableSql(projectId, datasetId, tableId);
  const res = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    sql,
  );
  if (!res.success) throw new Error(res.error || "Failed to inspect table");
  return { columns: res.data };
}

async function executeQueryImpl(
  connectionId: string,
  query: string,
  workspaceId: string,
) {
  if (
    !Types.ObjectId.isValid(connectionId) ||
    !Types.ObjectId.isValid(workspaceId)
  ) {
    throw new Error("Invalid connection ID or workspace ID");
  }
  const database = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!database) {
    throw new Error("Connection not found or access denied");
  }
  if (database.type !== "bigquery") {
    throw new Error(
      "execute_query only supports BigQuery connections in this tool",
    );
  }
  const safeQuery = appendLimitIfMissing(query);
  return databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    safeQuery,
  );
}

export const createBigQueryToolsV2 = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
): Record<string, AnyTool> => {
  const consoleTools = createConsoleToolsV2(consoles, preferredConsoleId);

  return {
    ...consoleTools,

    bq_list_connections: tool({
      description:
        "Return a list of all active BigQuery connections for the current workspace.",
      inputSchema: z.object({}),
      execute: async () => listBigQueryConnectionsImpl(workspaceId),
    }) as AnyTool,

    bq_list_datasets: tool({
      description:
        "List BigQuery datasets for the provided connection identifier.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
      }),
      execute: async (params: { connectionId: string }) =>
        listDatasetsImpl(params.connectionId, workspaceId),
    }) as AnyTool,

    bq_list_tables: tool({
      description: "List BigQuery tables for a given dataset.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        datasetId: z.string().describe("The dataset ID"),
      }),
      execute: async (params: { connectionId: string; datasetId: string }) =>
        listTablesImpl(params.connectionId, params.datasetId, workspaceId),
    }) as AnyTool,

    bq_inspect_table: tool({
      description:
        "Return columns with data types and nullability for a given table via INFORMATION_SCHEMA.",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        datasetId: z.string().describe("The dataset ID"),
        tableId: z.string().describe("The table ID"),
      }),
      execute: async (params: {
        connectionId: string;
        datasetId: string;
        tableId: string;
      }) =>
        inspectTableImpl(
          params.connectionId,
          params.datasetId,
          params.tableId,
          workspaceId,
        ),
    }) as AnyTool,

    bq_execute_query: tool({
      description:
        "Execute a BigQuery SQL query and return the results (LIMIT 500 enforced by default).",
      inputSchema: z.object({
        connectionId: z.string().describe("The connection ID"),
        query: z.string().describe("The SQL query to execute"),
      }),
      execute: async (params: { connectionId: string; query: string }) =>
        executeQueryImpl(params.connectionId, params.query, workspaceId),
    }) as AnyTool,
  };
};
