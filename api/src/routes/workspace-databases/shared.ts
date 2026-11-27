/**
 * What the workspace database routes share: loading a workspace's
 * MongoDB connection, resolving saved-console query definitions, request
 * execution options, ad-hoc Parquet downloads, the demo database config.
 */
import { checkConnectionWrite } from "../../access/connection-writes";
import type { Db } from "mongodb";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import type { IDatabaseConnection } from "../../database/workspace-schema";
import { connectionsRepo } from "../../repositories/connections";
import {
  databaseConnectionService,
  type QueryExecuteOptions,
} from "../../services/database-connection.service";
import { QueryLanguage } from "../../services/query-execution.service";
import { Types } from "mongoose";
import { loggers } from "../../logging";
import { ConsoleManager } from "../../utils/console-manager";
import { writeParquetTempFile } from "../../utils/parquet-serializer";
import { promises as fsPromises } from "fs";

export const logger = loggers.db();
export const consoleManager = new ConsoleManager();

export type WorkspaceDatabaseRouteError = {
  response: { success: false; error: string };
  status: 400 | 403 | 404;
};

export type WorkspaceDatabaseResult =
  WorkspaceDatabaseRouteError | { database: IDatabaseConnection };

export type WorkspaceMongoDbResult = WorkspaceDatabaseRouteError | { db: Db };

export function isWorkspaceDatabaseRouteError(
  result: WorkspaceDatabaseResult,
): result is WorkspaceDatabaseRouteError {
  return "response" in result;
}

export function isWorkspaceMongoDbRouteError(
  result: WorkspaceMongoDbResult,
): result is WorkspaceDatabaseRouteError {
  return "response" in result;
}

export async function getWorkspaceDatabase(
  workspaceId: Types.ObjectId,
  databaseId: string,
): Promise<WorkspaceDatabaseResult> {
  if (!Types.ObjectId.isValid(databaseId)) {
    return {
      response: { success: false, error: "Invalid database ID" },
      status: 400 as const,
    };
  }

  const database = await connectionsRepo.findDatabaseConnectionById(
    databaseId,
    String(workspaceId),
  );

  if (!database) {
    return {
      response: { success: false, error: "Database not found" },
      status: 404 as const,
    };
  }

  if (database.type !== "mongodb") {
    return {
      response: {
        success: false,
        error: "This endpoint is only for MongoDB databases",
      },
      status: 400 as const,
    };
  }

  return { database: database as unknown as IDatabaseConnection };
}

/**
 * The MongoDB database behind a connection. `write` names the change a
 * route is about to make with the raw client (createCollection,
 * dropCollection): it is checked against the connection's writers list
 * first, as a query would be (access/connection-writes.ts).
 */
export async function getWorkspaceMongoDb(
  workspaceId: Types.ObjectId,
  databaseId: string,
  write?: string,
): Promise<WorkspaceMongoDbResult> {
  const result = await getWorkspaceDatabase(workspaceId, databaseId);
  if (isWorkspaceDatabaseRouteError(result)) return result;
  if (write) {
    const check = await checkConnectionWrite(result.database, {
      operation: write,
    });
    if (check.refused) {
      return {
        response: { success: false, error: check.refused },
        status: 403 as const,
      };
    }
  }

  const connection = await databaseConnectionService.getConnection(
    result.database,
  );
  return {
    db: connection.db(result.database.connection.database),
  };
}

export function sanitizeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export type QueryDefinitionInput = {
  connectionId?: string;
  language?: "sql" | "javascript" | "mongodb";
  code?: string;
  databaseId?: string;
  databaseName?: string;
  mongoOptions?: {
    collection?: string;
    operation?:
      | "find"
      | "aggregate"
      | "insertMany"
      | "updateMany"
      | "deleteMany"
      | "findOne"
      | "updateOne"
      | "deleteOne";
  };
};

export function resolveQueryDefinition(
  body: Record<string, any>,
): QueryDefinitionInput | null {
  if (body.queryDefinition && typeof body.queryDefinition === "object") {
    return body.queryDefinition as QueryDefinitionInput;
  }

  if (typeof body.query === "string") {
    return {
      connectionId:
        typeof body.connectionId === "string" ? body.connectionId : undefined,
      language:
        typeof body.language === "string"
          ? (body.language as QueryDefinitionInput["language"])
          : undefined,
      code: body.query,
      databaseId:
        typeof body.databaseId === "string" ? body.databaseId : undefined,
      databaseName:
        typeof body.databaseName === "string" ? body.databaseName : undefined,
      mongoOptions:
        body.mongoOptions && typeof body.mongoOptions === "object"
          ? body.mongoOptions
          : undefined,
    };
  }

  return null;
}

export function buildExecutableQuery(
  queryDefinition: QueryDefinitionInput,
  databaseType: string,
) {
  const code = queryDefinition.code;
  if (typeof code !== "string" || !code.trim()) {
    return null;
  }

  if (
    databaseType === "mongodb" &&
    queryDefinition.language === "mongodb" &&
    queryDefinition.mongoOptions?.collection
  ) {
    return {
      collection: queryDefinition.mongoOptions.collection,
      operation: queryDefinition.mongoOptions.operation || "find",
      query: code,
    };
  }

  return code;
}

export async function parseRequestBody(
  c: AuthenticatedContext,
): Promise<Record<string, any>> {
  const contentType = c.req.header("content-type") || "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    return (await c.req.parseBody()) as Record<string, any>;
  }

  return await c.req.json();
}

export async function createAdHocParquetResponse(options: {
  database: IDatabaseConnection;
  executableQuery: any;
  queryDefinition: QueryDefinitionInput;
  filename: string;
}) {
  const queryResult = await databaseConnectionService.executeQuery(
    options.database,
    options.executableQuery,
    {
      databaseId: options.queryDefinition.databaseId,
      databaseName: options.queryDefinition.databaseName,
      readOnly: true,
      labels: { mako_source: "export" },
    },
  );

  if (!queryResult.success || !queryResult.data) {
    throw new Error(queryResult.error || "Query failed");
  }

  const rows = Array.isArray(queryResult.data) ? queryResult.data : [];
  const fields = (queryResult.fields || []).map((field: any) => ({
    name: field.name || field.columnName || String(field),
    type: field.type || field.dataType,
  }));
  const normalizedFields =
    fields.length > 0
      ? fields
      : rows.length > 0
        ? Object.keys(rows[0]).map(name => ({ name, type: undefined }))
        : [];

  const parquetFile = await writeParquetTempFile({
    rows,
    fields: normalizedFields,
    filenameBase: options.filename,
  });

  try {
    const fileBuffer = await fsPromises.readFile(parquetFile.filePath);
    return new Response(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        "Content-Disposition": `attachment; filename="${options.filename}.parquet"`,
        "Content-Length": String(parquetFile.byteSize),
        "X-Row-Count": String(parquetFile.rowCount),
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await fsPromises
      .rm(parquetFile.filePath, { force: true })
      .catch(() => undefined);
  }
}

/**
 * Determine query language from database type
 */
/**
 * The execution options a caller may set in a request body: where to run
 * and how to track it. Never the write check's own flags (`writeChecked`,
 * `actor`, `readOnlyTransaction`…), which a body must not be able to set.
 */
export function requestExecutionOptions(
  value: unknown,
): Pick<
  QueryExecuteOptions,
  "databaseName" | "databaseId" | "executionId" | "location" | "batchSize"
> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : undefined;
  return {
    databaseName: text("databaseName"),
    databaseId: text("databaseId"),
    executionId: text("executionId"),
    location: text("location"),
    batchSize:
      typeof raw.batchSize === "number" && Number.isFinite(raw.batchSize)
        ? raw.batchSize
        : undefined,
  };
}

export function getQueryLanguage(databaseType: string): QueryLanguage {
  if (databaseType === "mongodb") {
    return "mongodb";
  }
  if (databaseType === "cloudflare-kv") {
    return "javascript";
  }
  return "sql";
}

// Demo database configuration - returns config with connection string read at runtime
export function getDemoDatabaseConfig() {
  return {
    name: "Chinook Music Store",
    type: "postgresql" as const,
    connection: {
      // Use environment variable for demo database URL (Neon PostgreSQL)
      connectionString: process.env.DEMO_DATABASE_URL || "",
    },
  };
}
