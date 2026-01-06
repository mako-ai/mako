/**
 * Database Indexing Function
 * Explores all connections in a workspace to generate descriptions based on
 * actual schema inspection (tables, columns, sample data) without relying on chat history.
 */

import { inngest } from "../client";
import {
  DatabaseConnection,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { Types } from "mongoose";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { databaseRegistry } from "../../databases/registry";
import type { DatabaseTreeNode } from "../../databases/driver";

// Limit how many tables to inspect per database
const MAX_TABLES_PER_DATABASE = 20;

// Limit how many sample rows to fetch
const SAMPLE_ROW_LIMIT = 5;

// System tables/collections/schemas to skip (prefixes and exact names)
const SYSTEM_TABLE_PREFIXES = [
  "system.",
  "pg_",
  "information_schema.",
  "sql_",
  "hdb_", // Hasura system tables
];
const SYSTEM_TABLE_NAMES = [
  "system.views",
  "system.profile",
  "system.indexes",
  "system.namespaces",
  "system.js",
  "system.users",
  "system.roles",
  "system.sessions",
  "system.buckets",
  "sqlite_master",
  "sqlite_sequence",
  "sqlite_stat1",
  // PostgreSQL system schemas
  "pg_catalog",
  "information_schema",
  // Hasura system schemas
  "hdb_catalog",
  "hdb_views",
  // Cloud SQL admin schema
  "cloudsqladmin",
];

/**
 * Check if a table/collection name should be skipped (system tables)
 */
function isSystemTable(name: string): boolean {
  const lowerName = name.toLowerCase();

  // Check exact matches
  if (SYSTEM_TABLE_NAMES.includes(lowerName)) {
    return true;
  }

  // Check prefixes
  for (const prefix of SYSTEM_TABLE_PREFIXES) {
    if (lowerName.startsWith(prefix) || lowerName.includes(`.${prefix}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a summary for a connection based on its database descriptions
 */
async function generateConnectionSummary(
  connectionName: string,
  databases: Array<{ name: string; description?: string }>,
): Promise<string | null> {
  const describedDatabases = databases.filter(db => db.description?.trim());

  if (describedDatabases.length === 0) {
    return null;
  }

  const databaseList = describedDatabases
    .map(db => `- ${db.name}: ${db.description}`)
    .join("\n");

  const prompt = `Summarize what this database connection contains based on the databases below. Be concise and factual.

Connection: ${connectionName}

Databases:
${databaseList}

Write a high-level summary (max 300 characters) that explains the overall purpose of this connection. Focus on the main data domains.

Respond with ONLY the summary text, nothing else.`;

  try {
    const result = await generateText({
      model: openai("gpt-4o-mini") as any,
      prompt,
      maxOutputTokens: 150,
    });

    const summary = result.text.trim();
    if (summary.length < 10 || summary.length > 500) {
      return null;
    }

    return summary;
  } catch (error) {
    console.error(
      `[DatabaseIndexing] Failed to generate summary for ${connectionName}:`,
      error,
    );
    return null;
  }
}

/**
 * Set the connection summary
 */
async function setConnectionSummary(
  connectionId: Types.ObjectId,
  summary: string,
): Promise<void> {
  await DatabaseConnection.updateOne(
    { _id: connectionId },
    { $set: { summary } },
  );
}

/**
 * Generate and save connection summary based on existing database descriptions
 */
async function summarizeConnection(
  connectionId: string,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  try {
    const connection = await DatabaseConnection.findById(connectionId).select({
      name: 1,
      databases: 1,
    });

    if (!connection) {
      return { success: false, error: "Connection not found" };
    }

    const summary = await generateConnectionSummary(
      connection.name,
      connection.databases || [],
    );

    if (summary) {
      await setConnectionSummary(connection._id, summary);
      console.log(
        `[DatabaseIndexing] Generated summary for ${connection.name}: "${summary.slice(0, 50)}..."`,
      );
      return { success: true, summary };
    }

    return { success: false, error: "Failed to generate summary" };
  } catch (error) {
    console.error(`[DatabaseIndexing] Error summarizing connection:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Generate a description for a database based on its schema
 */
async function generateDatabaseDescription(
  connectionName: string,
  databaseName: string,
  schema: {
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string }>;
      sampleData?: Record<string, unknown>[];
    }>;
  },
): Promise<string | null> {
  if (schema.tables.length === 0) {
    return null;
  }

  // Build schema summary
  const schemaSummary = schema.tables
    .slice(0, MAX_TABLES_PER_DATABASE)
    .map(table => {
      const columnList = table.columns
        .slice(0, 15)
        .map(c => `${c.name} (${c.type})`)
        .join(", ");
      const truncated = table.columns.length > 15 ? "..." : "";

      let tableInfo = `- ${table.name}: ${columnList}${truncated}`;

      if (table.sampleData && table.sampleData.length > 0) {
        // Show field names from sample to infer content
        const sampleFields = Object.keys(table.sampleData[0]).slice(0, 10);
        const sampleValues = table.sampleData
          .slice(0, 2)
          .map(row => {
            return sampleFields
              .map(f => {
                const val = row[f];
                const strVal =
                  typeof val === "string"
                    ? val.slice(0, 50)
                    : JSON.stringify(val)?.slice(0, 50);
                return `${f}=${strVal}`;
              })
              .join(", ");
          })
          .join(" | ");
        tableInfo += `\n    Sample: ${sampleValues}`;
      }

      return tableInfo;
    })
    .join("\n");

  const prompt = `Describe what this database stores based ONLY on the schema below. Be specific and factual. Mention actual table/collection names. Do NOT speculate about business domains if the purpose is unclear from the schema.

Database: ${databaseName}
Connection: ${connectionName}

Tables/Collections:
${schemaSummary}

Write a factual description (max 200 characters) of what data is stored. Examples:
- "Airbyte sync metadata: jobs, attempts, state tracking tables"
- "User data: accounts, sessions, preferences, notifications"
- "E-commerce: products, orders, customers, payments"

Respond with ONLY the description text, nothing else.`;

  try {
    const result = await generateText({
      model: openai("gpt-4o-mini") as any,
      prompt,
      maxOutputTokens: 150,
    });

    const description = result.text.trim();
    if (description.length < 10 || description.length > 500) {
      return null;
    }

    return description;
  } catch (error) {
    console.error(
      `[DatabaseIndexing] Failed to generate description for ${databaseName}:`,
      error,
    );
    return null;
  }
}

/**
 * Collect schema information for a single database/dataset using ONLY tree traversal.
 * This ensures we only get schema for the specific database, not all databases in the connection.
 */
async function collectDatabaseSchema(
  connection: IDatabaseConnection,
  databaseName: string,
  databaseKind: string,
  driver: ReturnType<typeof databaseRegistry.getDriver>,
): Promise<{
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    sampleData?: Record<string, unknown>[];
  }>;
}> {
  const tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    sampleData?: Record<string, unknown>[];
  }> = [];

  if (!driver) {
    return { tables };
  }

  try {
    // Use tree traversal to get ONLY tables for THIS specific database
    // Pass the correct kind based on what the tree root returned
    const children = await driver.getChildren(connection, {
      kind: databaseKind,
      id: databaseName,
      metadata: {
        databaseName,
        databaseId: databaseName,
        datasetId: databaseName,
      },
    });

    console.log(
      `[DatabaseIndexing] Got ${children.length} children for ${databaseName} (kind: ${databaseKind})`,
    );

    // Process children - could be tables directly, schemas, or groups containing tables
    for (const child of children) {
      if (tables.length >= MAX_TABLES_PER_DATABASE) break;

      // Handle schema nodes (PostgreSQL/MySQL schemas like "public", "hdb_catalog")
      if (child.kind === "schema" || child.kind === "SCHEMA") {
        // Skip system schemas
        if (isSystemTable(child.label)) {
          console.log(
            `[DatabaseIndexing] Skipping system schema: ${child.label}`,
          );
          continue;
        }

        console.log(`[DatabaseIndexing] Drilling into schema: ${child.label}`);

        // Get children of the schema (could be tables directly or groups)
        const schemaChildren = await driver.getChildren(connection, {
          kind: child.kind,
          id: child.id,
          metadata: child.metadata,
        });

        for (const schemaChild of schemaChildren) {
          if (tables.length >= MAX_TABLES_PER_DATABASE) break;

          // Schema children could be table/view nodes directly
          if (
            schemaChild.kind === "table" ||
            schemaChild.kind === "TABLE" ||
            schemaChild.kind === "view" ||
            schemaChild.kind === "VIEW"
          ) {
            if (!isSystemTable(schemaChild.label)) {
              const columns = await getTableColumns(
                driver,
                connection,
                schemaChild,
              );
              // Include schema in table name for clarity
              tables.push({
                name: `${child.label}.${schemaChild.label}`,
                columns,
              });
            }
          }
          // Or could be group nodes (like "Tables", "Views")
          else if (schemaChild.kind === "group") {
            const groupChildren = await driver.getChildren(connection, {
              kind: schemaChild.kind,
              id: schemaChild.id,
              metadata: schemaChild.metadata,
            });

            for (const tableNode of groupChildren) {
              if (tables.length >= MAX_TABLES_PER_DATABASE) break;
              if (!isSystemTable(tableNode.label)) {
                const columns = await getTableColumns(
                  driver,
                  connection,
                  tableNode,
                );
                tables.push({
                  name: `${child.label}.${tableNode.label}`,
                  columns,
                });
              }
            }
          }
        }
      }
      // Handle group nodes (like "Collections", "Tables" in MongoDB)
      else if (
        child.kind === "group" &&
        (child.label === "Collections" ||
          child.label === "Tables" ||
          child.label === "Views")
      ) {
        const tableNodes = await driver.getChildren(connection, {
          kind: child.kind,
          id: child.id,
          metadata: child.metadata,
        });

        for (const tableNode of tableNodes) {
          if (tables.length >= MAX_TABLES_PER_DATABASE) break;
          if (!isSystemTable(tableNode.label)) {
            // Try to get columns for this table
            const columns = await getTableColumns(
              driver,
              connection,
              tableNode,
            );
            tables.push({
              name: tableNode.label,
              columns,
            });
          }
        }
      }
      // Handle table/collection nodes directly
      else if (
        child.kind === "collection" ||
        child.kind === "table" ||
        child.kind === "TABLE" ||
        child.kind === "view"
      ) {
        if (!isSystemTable(child.label)) {
          // Try to get columns for this table
          const columns = await getTableColumns(driver, connection, child);
          tables.push({
            name: child.label,
            columns,
          });
        }
      }
    }

    console.log(
      `[DatabaseIndexing] Found ${tables.length} tables in ${databaseName}`,
    );

    // Sample data from first few tables
    const tablesToSample = tables.slice(0, 3);

    for (const table of tablesToSample) {
      try {
        const tableName = table.name;

        // Skip system tables by name
        if (isSystemTable(tableName)) {
          continue;
        }

        // Build a simple query based on database type
        const metadata = driver.getMetadata();
        let query = "";

        if (metadata.consoleLanguage === "mongodb") {
          query = `db.getCollection("${tableName}").find({}).limit(${SAMPLE_ROW_LIMIT})`;
        } else if (metadata.consoleLanguage === "sql") {
          // For SQL, use fully qualified name if available
          const dbType = metadata.type;
          if (dbType === "bigquery") {
            const projectId = (connection.connection as any)?.project_id;
            query = `SELECT * FROM \`${projectId}.${databaseName}.${tableName}\` LIMIT ${SAMPLE_ROW_LIMIT}`;
          } else if (dbType === "clickhouse") {
            query = `SELECT * FROM "${databaseName}"."${tableName}" LIMIT ${SAMPLE_ROW_LIMIT}`;
          } else {
            query = `SELECT * FROM ${tableName} LIMIT ${SAMPLE_ROW_LIMIT}`;
          }
        }

        if (query) {
          const result = await driver.executeQuery(connection, query, {
            databaseName,
            datasetId: databaseName,
          });

          if (result.success && Array.isArray(result.data)) {
            table.sampleData = result.data.slice(0, SAMPLE_ROW_LIMIT);
          }
        }
      } catch (err) {
        console.log(
          `[DatabaseIndexing] Failed to sample ${table.name}: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[DatabaseIndexing] Error collecting schema for ${databaseName}:`,
      error,
    );
  }

  return { tables };
}

/**
 * Try to get columns for a table by querying its children in the tree
 */
async function getTableColumns(
  driver: ReturnType<typeof databaseRegistry.getDriver>,
  connection: IDatabaseConnection,
  tableNode: DatabaseTreeNode,
): Promise<Array<{ name: string; type: string }>> {
  if (!driver || !tableNode.hasChildren) {
    return [];
  }

  try {
    const columnNodes = await driver.getChildren(connection, {
      kind: tableNode.kind,
      id: tableNode.id,
      metadata: tableNode.metadata,
    });

    // Filter to only column nodes
    return columnNodes
      .filter(node => node.kind === "column" || node.kind === "field")
      .map(node => ({
        name: node.label,
        type: node.metadata?.type || node.metadata?.dataType || "unknown",
      }))
      .slice(0, 30); // Limit columns
  } catch {
    return [];
  }
}

/**
 * Set or update the description for a database
 */
async function setDatabaseDescription(
  connectionId: Types.ObjectId,
  databaseName: string,
  description: string,
): Promise<void> {
  // Check if database entry exists
  const connection = await DatabaseConnection.findById(connectionId).select({
    databases: 1,
  });

  if (!connection) return;

  const dbExists = connection.databases?.some(db => db.name === databaseName);

  if (dbExists) {
    // Update existing database entry
    await DatabaseConnection.updateOne(
      {
        _id: connectionId,
        "databases.name": databaseName,
      },
      {
        $set: { "databases.$.description": description },
      },
    );
  } else {
    // Create new database entry
    await DatabaseConnection.updateOne(
      { _id: connectionId },
      {
        $push: {
          databases: {
            name: databaseName,
            description,
          },
        },
      },
    );
  }
}

/**
 * Process a single workspace for database indexing
 */
async function indexWorkspaceDatabases(
  workspaceId: string,
): Promise<{ connectionsProcessed: number; descriptionsGenerated: number }> {
  let descriptionsGenerated = 0;

  console.log(
    `[DatabaseIndexing] Starting indexing for workspace ${workspaceId}`,
  );

  // Get all connections for this workspace
  const connections = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
  });

  if (connections.length === 0) {
    console.log(
      `[DatabaseIndexing] No connections found for workspace ${workspaceId}`,
    );
    return { connectionsProcessed: 0, descriptionsGenerated: 0 };
  }

  console.log(
    `[DatabaseIndexing] Found ${connections.length} connections to process`,
  );

  for (const connection of connections) {
    let connectionDescriptions = 0;
    const driver = databaseRegistry.getDriver(connection.type);
    if (!driver) {
      console.log(
        `[DatabaseIndexing] No driver found for ${connection.type}, skipping ${connection.name}`,
      );
      continue;
    }

    try {
      // Get list of databases
      let databases: DatabaseTreeNode[] = [];

      try {
        databases = await driver.getTreeRoot(connection);
      } catch (error) {
        console.error(
          `[DatabaseIndexing] Failed to get tree root for ${connection.name}:`,
          error,
        );
        continue;
      }

      // Filter to only database/dataset nodes (different drivers use different kinds)
      const validKinds = ["database", "dataset", "DATASET"];
      const databaseNodes = databases.filter(node =>
        validKinds.includes(node.kind),
      );

      console.log(
        `[DatabaseIndexing] Connection ${connection.name} (${connection.type}) has ${databaseNodes.length} database(s)`,
      );

      // If no database nodes found, log what we got
      if (databaseNodes.length === 0 && databases.length > 0) {
        console.log(
          `[DatabaseIndexing] No database nodes found, got kinds: ${databases.map(n => n.kind).join(", ")}`,
        );
      }

      for (const dbNode of databaseNodes) {
        const databaseName =
          dbNode.metadata?.databaseName ||
          dbNode.metadata?.datasetId ||
          dbNode.id ||
          dbNode.label;

        console.log(
          `[DatabaseIndexing] Processing ${dbNode.kind} "${databaseName}" in ${connection.name}`,
        );

        // Collect schema - pass the node's kind so we query correctly
        const schema = await collectDatabaseSchema(
          connection,
          databaseName,
          dbNode.kind,
          driver,
        );

        if (schema.tables.length === 0) {
          console.log(
            `[DatabaseIndexing] No tables found in ${databaseName}, skipping`,
          );
          continue;
        }

        console.log(
          `[DatabaseIndexing] Found ${schema.tables.length} tables in ${databaseName}`,
        );

        // Generate description
        const description = await generateDatabaseDescription(
          connection.name,
          databaseName,
          schema,
        );

        if (description) {
          await setDatabaseDescription(
            connection._id,
            databaseName,
            description,
          );

          descriptionsGenerated++;
          connectionDescriptions++;
          console.log(
            `[DatabaseIndexing] Generated description for ${connection.name}/${databaseName}: "${description.slice(0, 100)}..."`,
          );
        }
      }

      // Generate connection summary after all databases in this connection
      if (connectionDescriptions > 0) {
        const summaryResult = await summarizeConnection(
          connection._id.toString(),
        );
        if (summaryResult.success) {
          console.log(
            `[DatabaseIndexing] Generated summary for connection ${connection.name}`,
          );
        }
      }
    } catch (error) {
      console.error(
        `[DatabaseIndexing] Error processing connection ${connection.name}:`,
        error,
      );
    }
  }

  console.log(
    `[DatabaseIndexing] Completed: ${connections.length} connections, ${descriptionsGenerated} descriptions`,
  );

  return {
    connectionsProcessed: connections.length,
    descriptionsGenerated,
  };
}

/**
 * Index a single database within a connection
 */
export async function indexSingleDatabase(
  connectionId: string,
  databaseName: string,
): Promise<{ success: boolean; description?: string; error?: string }> {
  const connection = await DatabaseConnection.findById(connectionId);

  if (!connection) {
    return { success: false, error: "Connection not found" };
  }

  console.log(
    `[DatabaseIndexing] Single database index for ${connection.name}/${databaseName}`,
  );

  try {
    const driver = databaseRegistry.getDriver(connection.type);
    if (!driver) {
      return {
        success: false,
        error: `Unsupported database type: ${connection.type}`,
      };
    }

    // Get the tree root to find databases
    let databases: DatabaseTreeNode[] = [];
    try {
      databases = await driver.getTreeRoot(connection);
    } catch (error) {
      console.error(
        `[DatabaseIndexing] Failed to get tree root for ${connection.name}:`,
        error,
      );
      return { success: false, error: "Failed to connect to database" };
    }

    // Valid database node kinds
    const validKinds = ["database", "dataset", "DATASET"];

    // Find the target database node
    let targetDbNode: DatabaseTreeNode | null = null;
    for (const node of databases) {
      if (
        validKinds.includes(node.kind) &&
        (node.label === databaseName ||
          node.metadata?.databaseName === databaseName ||
          node.metadata?.datasetId === databaseName ||
          node.id === databaseName)
      ) {
        targetDbNode = node;
        break;
      }
    }

    // If not found, try using the first valid kind we can find and create synthetic node
    if (!targetDbNode) {
      const databaseKind =
        databases.find(n => validKinds.includes(n.kind))?.kind || "database";
      targetDbNode = {
        label: databaseName,
        kind: databaseKind,
        id: databaseName,
        metadata: {
          databaseName,
          databaseId: databaseName,
          datasetId: databaseName,
        },
      };
    }

    // Collect schema for this specific database
    const schema = await collectDatabaseSchema(
      connection,
      databaseName,
      targetDbNode.kind,
      driver,
    );

    if (schema.tables.length === 0) {
      return { success: false, error: "No tables found in database" };
    }

    // Generate description
    const description = await generateDatabaseDescription(
      connection.name,
      databaseName,
      schema,
    );

    if (description) {
      await setDatabaseDescription(connection._id, databaseName, description);

      console.log(
        `[DatabaseIndexing] Generated description for ${connection.name}/${databaseName}`,
      );

      return { success: true, description };
    }

    return { success: false, error: "Failed to generate description" };
  } catch (error) {
    console.error(
      `[DatabaseIndexing] Error indexing ${connection.name}/${databaseName}:`,
      error,
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Index all databases within a single connection
 */
export async function indexConnectionDatabases(connectionId: string): Promise<{
  success: boolean;
  descriptionsGenerated: number;
  error?: string;
}> {
  const connection = await DatabaseConnection.findById(connectionId);

  if (!connection) {
    return {
      success: false,
      descriptionsGenerated: 0,
      error: "Connection not found",
    };
  }

  console.log(
    `[DatabaseIndexing] Indexing all databases for connection ${connection.name}`,
  );

  let descriptionsGenerated = 0;

  try {
    const driver = databaseRegistry.getDriver(connection.type);
    if (!driver) {
      return {
        success: false,
        descriptionsGenerated: 0,
        error: `Unsupported database type: ${connection.type}`,
      };
    }

    // Get list of databases
    let databases: DatabaseTreeNode[] = [];
    try {
      databases = await driver.getTreeRoot(connection);
    } catch (error) {
      console.error(
        `[DatabaseIndexing] Failed to get tree root for ${connection.name}:`,
        error,
      );
      return {
        success: false,
        descriptionsGenerated: 0,
        error: "Failed to connect to database",
      };
    }

    // Filter to only database/dataset nodes
    const validKinds = ["database", "dataset", "DATASET"];
    const databaseNodes = databases.filter(node =>
      validKinds.includes(node.kind),
    );

    console.log(
      `[DatabaseIndexing] Connection ${connection.name} has ${databaseNodes.length} database(s)`,
    );

    for (const dbNode of databaseNodes) {
      const databaseName =
        dbNode.metadata?.databaseName ||
        dbNode.metadata?.datasetId ||
        dbNode.id ||
        dbNode.label;

      // Collect schema
      const schema = await collectDatabaseSchema(
        connection,
        databaseName,
        dbNode.kind,
        driver,
      );

      if (schema.tables.length === 0) {
        console.log(
          `[DatabaseIndexing] No tables found in ${databaseName}, skipping`,
        );
        continue;
      }

      // Generate description
      const description = await generateDatabaseDescription(
        connection.name,
        databaseName,
        schema,
      );

      if (description) {
        await setDatabaseDescription(connection._id, databaseName, description);

        descriptionsGenerated++;
        console.log(
          `[DatabaseIndexing] Generated description for ${connection.name}/${databaseName}`,
        );
      }
    }

    // Generate connection summary based on all database descriptions
    if (descriptionsGenerated > 0) {
      const summaryResult = await summarizeConnection(connectionId);
      if (summaryResult.success) {
        console.log(
          `[DatabaseIndexing] Generated summary for connection ${connection.name}`,
        );
      }
    }

    return { success: true, descriptionsGenerated };
  } catch (error) {
    console.error(
      `[DatabaseIndexing] Error indexing connection ${connection.name}:`,
      error,
    );
    return {
      success: false,
      descriptionsGenerated,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Manual trigger for database indexing
 * Processes a single workspace, a single connection, or a single database
 */
export const indexDatabases = inngest.createFunction(
  {
    id: "index-databases",
    name: "Index Databases",
    retries: 0,
  },
  { event: "database/index.manual" },
  async ({ event }) => {
    const { workspaceId, connectionId, databaseName } = event.data as {
      workspaceId?: string;
      connectionId?: string;
      databaseName?: string;
    };

    // If connectionId and databaseName provided, index single database
    if (connectionId && databaseName) {
      console.log(
        `[DatabaseIndexing] Single database trigger for ${connectionId}/${databaseName}`,
      );

      const result = await indexSingleDatabase(connectionId, databaseName);

      return {
        success: result.success,
        connectionId,
        databaseName,
        description: result.description,
        error: result.error,
      };
    }

    // If only connectionId provided, index all databases in that connection
    if (connectionId && !databaseName) {
      console.log(`[DatabaseIndexing] Connection trigger for ${connectionId}`);

      const result = await indexConnectionDatabases(connectionId);

      return {
        success: result.success,
        connectionId,
        descriptionsGenerated: result.descriptionsGenerated,
        error: result.error,
      };
    }

    // Otherwise, process entire workspace
    if (!workspaceId) {
      console.log(
        "[DatabaseIndexing] Manual trigger called without workspaceId",
      );
      return { success: false, error: "workspaceId is required" };
    }

    console.log(
      `[DatabaseIndexing] Manual trigger for workspace ${workspaceId}`,
    );

    const result = await indexWorkspaceDatabases(workspaceId);

    console.log(
      `[DatabaseIndexing] Manual indexing complete: ${result.connectionsProcessed} connections, ${result.descriptionsGenerated} descriptions`,
    );

    return {
      success: true,
      workspaceId,
      ...result,
    };
  },
);

/**
 * Manual trigger for connection summarization
 * Generates a summary for a connection based on its database descriptions
 */
export const summarizeConnectionFunction = inngest.createFunction(
  {
    id: "summarize-connection",
    name: "Summarize Connection",
    retries: 0,
  },
  { event: "connection/summarize.manual" },
  async ({ event }) => {
    const { connectionId } = event.data as { connectionId: string };

    if (!connectionId) {
      return { success: false, error: "connectionId is required" };
    }

    console.log(`[DatabaseIndexing] Summarizing connection ${connectionId}`);

    const result = await summarizeConnection(connectionId);

    return {
      success: result.success,
      connectionId,
      summary: result.summary,
      error: result.error,
    };
  },
);
