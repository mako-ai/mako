// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { createConsoleTools, ConsoleData } from "../shared/console-tools";

const listBigQueryConnections = async (workspaceId: string) => {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).sort({ name: 1 });

  return databases
    .filter(db => db.type === "bigquery")
    .map(db => {
      const conn: any = (db as any).connection || {};
      const projectId = conn.project_id || "unknown-project";
      return {
        id: db._id.toString(),
        name: db.name,
        description: "",
        // For BigQuery, surface project identifier for display
        project: projectId,
        type: db.type,
        active: true,
        displayName: `BigQuery (${projectId})`,
      };
    });
};

const listDatasets = async (connectionId: string, workspaceId: string) => {
  // Enforce non-empty, valid ObjectId for connectionId
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
    database as any,
  );
  return datasets.map(ds => ({ datasetId: ds }));
};

const listTables = async (
  connectionId: string,
  datasetId: string,
  workspaceId: string,
) => {
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
    database as any,
    datasetId,
  );
  return items.map(it => ({ name: it.name, type: it.type }));
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

const inspectTable = async (
  connectionId: string,
  datasetId: string,
  tableId: string,
  workspaceId: string,
) => {
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
  const projectId = (database as any).connection?.project_id;
  if (!projectId) throw new Error("BigQuery connection missing project_id");
  const sql = buildInspectTableSql(projectId, datasetId, tableId);
  const res = await databaseConnectionService.executeQuery(
    database as any,
    sql,
  );
  if (!res.success) throw new Error(res.error || "Failed to inspect table");
  return { columns: res.data };
};

const appendLimitIfMissing = (sql: string): string => {
  const hasLimit = /\blimit\s+\d+\b/i.test(sql);
  if (hasLimit) return sql;
  const trimmed = sql.replace(/;\s*$/i, "");
  return `${trimmed}\nLIMIT 500;`;
};

const executeBigQuerySql = async (
  connectionId: string,
  query: string,
  workspaceId: string,
) => {
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
  const res = await databaseConnectionService.executeQuery(
    database as any,
    safeQuery,
  );
  return res;
};

export const createBigQueryTools = (
  workspaceId: string,
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  // Discovery: list BigQuery database connections in this workspace
  const listConnectionsBq = tool({
    name: "bq_list_connections",
    description:
      "Return a list of all active BigQuery connections for the current workspace.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (_: any) => listBigQueryConnections(workspaceId),
  });

  // Optional alias to match generic naming within the BigQuery agent
  const listConnectionsAlias = tool({
    name: "list_connections",
    description:
      "Alias for listing BigQuery connections (scoped to the current workspace).",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async (_: any) => listBigQueryConnections(workspaceId),
  });

  const listDatasetsTool = tool({
    name: "bq_list_datasets",
    description:
      "List BigQuery datasets for the provided connection identifier.",
    parameters: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listDatasets(input.connectionId, workspaceId),
  });

  const listDatasetsAlias = tool({
    name: "list_datasets",
    description:
      "Alias: List BigQuery datasets for the provided connection identifier.",
    parameters: {
      type: "object",
      properties: { connectionId: { type: "string" } },
      required: ["connectionId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listDatasets(input.connectionId, workspaceId),
  });

  const listTablesTool = tool({
    name: "bq_list_tables",
    description: "List BigQuery tables for a given dataset.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        datasetId: { type: "string" },
      },
      required: ["connectionId", "datasetId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listTables(input.connectionId, input.datasetId, workspaceId),
  });

  const listTablesAlias = tool({
    name: "list_tables",
    description: "Alias: List BigQuery tables for a given dataset.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        datasetId: { type: "string" },
      },
      required: ["connectionId", "datasetId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      listTables(input.connectionId, input.datasetId, workspaceId),
  });

  const inspectTableTool = tool({
    name: "bq_inspect_table",
    description:
      "Return columns with data types and nullability for a given table via INFORMATION_SCHEMA.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        datasetId: { type: "string" },
        tableId: { type: "string" },
      },
      required: ["connectionId", "datasetId", "tableId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      inspectTable(
        input.connectionId,
        input.datasetId,
        input.tableId,
        workspaceId,
      ),
  });

  const inspectTableAlias = tool({
    name: "inspect_table",
    description:
      "Alias: Return columns with data types and nullability for a given table via INFORMATION_SCHEMA.",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        datasetId: { type: "string" },
        tableId: { type: "string" },
      },
      required: ["connectionId", "datasetId", "tableId"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      inspectTable(
        input.connectionId,
        input.datasetId,
        input.tableId,
        workspaceId,
      ),
  });

  const executeSqlTool = tool({
    name: "bq_execute_query",
    description:
      "Execute a BigQuery SQL query and return the results (LIMIT 500 enforced by default).",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        query: { type: "string" },
      },
      required: ["connectionId", "query"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeBigQuerySql(input.connectionId, input.query, workspaceId),
  });

  const executeSqlAlias = tool({
    name: "execute_query",
    description:
      "Alias: Execute a BigQuery SQL query and return the results (LIMIT 500 enforced by default).",
    parameters: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        query: { type: "string" },
      },
      required: ["connectionId", "query"],
      additionalProperties: false,
    },
    execute: async (input: any) =>
      executeBigQuerySql(input.connectionId, input.query, workspaceId),
  });

  const consoleTools = createConsoleTools(consoles, preferredConsoleId);

  return [
    listConnectionsBq,
    listConnectionsAlias,
    listDatasetsTool,
    listDatasetsAlias,
    listTablesTool,
    listTablesAlias,
    inspectTableTool,
    inspectTableAlias,
    executeSqlTool,
    executeSqlAlias,
    ...consoleTools,
  ];
};
