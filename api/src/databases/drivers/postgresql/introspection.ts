import { DatabaseTreeNode } from "../../driver";

type TreeQueryExecutor = (
  query: string,
  options?: { databaseName?: string },
) => Promise<{ success: boolean; data?: any; error?: string }>;

/** Object groups shown under a table node (DataGrip-style). */
export type PostgresTableGroup = "columns" | "keys" | "indexes" | "triggers";

interface TableParentRef {
  schema: string;
  table: string;
  dbName?: string;
  safeSchema: string;
  safeTable: string;
}

function resolveTableParent(parent: { metadata?: any }): TableParentRef | null {
  const schema = parent.metadata?.schema;
  const table = parent.metadata?.table;
  if (!schema || !table) return null;
  return {
    schema: String(schema),
    table: String(table),
    dbName: parent.metadata?.databaseName || parent.metadata?.databaseId,
    safeSchema: String(schema).replace(/'/g, "''"),
    safeTable: String(table).replace(/'/g, "''"),
  };
}

/**
 * Children of a table/view node or one of its object-group folders.
 *
 * - table  → group folders (columns / keys / indexes / triggers) with counts
 * - view   → columns group only (views have no keys/indexes; INSTEAD OF
 *            triggers are rare enough to not warrant the extra folders)
 * - group  → the actual objects of that group
 */
export async function listPostgresTableLevelChildren(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  if (parent.kind === "table" || parent.kind === "view") {
    return listPostgresTableGroups(executeQuery, parent);
  }
  if (parent.kind === "group") {
    const group = parent.metadata?.group as PostgresTableGroup | undefined;
    switch (group) {
      case "columns":
        return listPostgresTableColumns(executeQuery, parent);
      case "keys":
        return listPostgresTableKeys(executeQuery, parent);
      case "indexes":
        return listPostgresTableIndexes(executeQuery, parent);
      case "triggers":
        return listPostgresTableTriggers(executeQuery, parent);
      default:
        return [];
    }
  }
  return [];
}

async function listPostgresTableGroups(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  const ref = resolveTableParent(parent);
  if (!ref) return [];
  const { safeSchema, safeTable, dbName } = ref;

  const result = await executeQuery(
    `SELECT
       (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = '${safeSchema}' AND table_name = '${safeTable}') AS columns,
       (SELECT count(*)::int FROM information_schema.table_constraints
         WHERE table_schema = '${safeSchema}' AND table_name = '${safeTable}'
           AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')) AS keys,
       (SELECT count(*)::int FROM pg_indexes
         WHERE schemaname = '${safeSchema}' AND tablename = '${safeTable}') AS indexes,
       (SELECT count(DISTINCT trigger_name)::int FROM information_schema.triggers
         WHERE event_object_schema = '${safeSchema}' AND event_object_table = '${safeTable}') AS triggers;`,
    { databaseName: dbName },
  );

  if (!result.success || !result.data?.[0]) return [];
  const counts = result.data[0] as Record<PostgresTableGroup, number>;

  const groups: PostgresTableGroup[] =
    parent.kind === "view"
      ? ["columns"]
      : ["columns", "keys", "indexes", "triggers"];

  return groups.map<DatabaseTreeNode>(group => ({
    id: `${parent.id}#${group}`,
    label: group,
    kind: "group",
    hasChildren: true,
    metadata: {
      ...parent.metadata,
      group,
      count: Number(counts[group]) || 0,
      tableKind: parent.kind,
    },
  }));
}

async function listPostgresTableKeys(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  const ref = resolveTableParent(parent);
  if (!ref) return [];
  const { schema, table, safeSchema, safeTable, dbName } = ref;

  const result = await executeQuery(
    `SELECT
       tc.constraint_name,
       tc.constraint_type,
       string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
     FROM information_schema.table_constraints tc
     LEFT JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
     WHERE tc.table_schema = '${safeSchema}'
       AND tc.table_name = '${safeTable}'
       AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
     GROUP BY tc.constraint_name, tc.constraint_type
     ORDER BY CASE tc.constraint_type
       WHEN 'PRIMARY KEY' THEN 0 WHEN 'UNIQUE' THEN 1 ELSE 2 END,
       tc.constraint_name;`,
    { databaseName: dbName },
  );

  if (!result.success || !result.data) return [];
  const rows: Array<{
    constraint_name: string;
    constraint_type: string;
    columns: string | null;
  }> = result.data;

  return rows.map<DatabaseTreeNode>(r => ({
    id: `${parent.id}.${r.constraint_name}`,
    label: r.constraint_name,
    kind: "key",
    hasChildren: false,
    metadata: {
      schema,
      table,
      keyName: r.constraint_name,
      keyType: r.constraint_type,
      columns: r.columns || undefined,
      databaseId: dbName,
      databaseName: dbName,
    },
  }));
}

async function listPostgresTableIndexes(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  const ref = resolveTableParent(parent);
  if (!ref) return [];
  const { schema, table, safeSchema, safeTable, dbName } = ref;

  const result = await executeQuery(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = '${safeSchema}' AND tablename = '${safeTable}'
     ORDER BY indexname;`,
    { databaseName: dbName },
  );

  if (!result.success || !result.data) return [];
  const rows: Array<{ indexname: string; indexdef: string }> = result.data;

  return rows.map<DatabaseTreeNode>(r => {
    const def = r.indexdef || "";
    const isUnique = /\bCREATE UNIQUE INDEX\b/i.test(def);
    const methodMatch = def.match(/\bUSING\s+(\w+)/i);
    return {
      id: `${parent.id}.${r.indexname}`,
      label: r.indexname,
      kind: "index",
      hasChildren: false,
      metadata: {
        schema,
        table,
        indexName: r.indexname,
        isUnique,
        method: methodMatch ? methodMatch[1] : undefined,
        definition: def,
        databaseId: dbName,
        databaseName: dbName,
      },
    };
  });
}

async function listPostgresTableTriggers(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  const ref = resolveTableParent(parent);
  if (!ref) return [];
  const { schema, table, safeSchema, safeTable, dbName } = ref;

  const result = await executeQuery(
    `SELECT
       trigger_name,
       min(action_timing) AS timing,
       string_agg(DISTINCT event_manipulation, ' OR ') AS events
     FROM information_schema.triggers
     WHERE event_object_schema = '${safeSchema}'
       AND event_object_table = '${safeTable}'
     GROUP BY trigger_name
     ORDER BY trigger_name;`,
    { databaseName: dbName },
  );

  if (!result.success || !result.data) return [];
  const rows: Array<{
    trigger_name: string;
    timing: string | null;
    events: string | null;
  }> = result.data;

  return rows.map<DatabaseTreeNode>(r => ({
    id: `${parent.id}.${r.trigger_name}`,
    label: r.trigger_name,
    kind: "trigger",
    hasChildren: false,
    metadata: {
      schema,
      table,
      triggerName: r.trigger_name,
      timing: r.timing || undefined,
      events: r.events || undefined,
      databaseId: dbName,
      databaseName: dbName,
    },
  }));
}

/**
 * List the columns of a Postgres table or view as tree leaf nodes, including
 * data type, nullability, and primary-key membership.
 *
 * Shared by the Postgres-family drivers (postgresql, cloudsql-postgres,
 * redshift) which differ only in how they execute queries. Kept in its own
 * module (instead of driver.ts) to avoid circular imports between drivers.
 */
export async function listPostgresTableColumns(
  executeQuery: TreeQueryExecutor,
  parent: { kind: string; id: string; metadata?: any },
): Promise<DatabaseTreeNode[]> {
  const schema = parent.metadata?.schema;
  const table = parent.metadata?.table;
  if (!schema || !table) return [];

  const dbName = parent.metadata?.databaseName || parent.metadata?.databaseId;
  const safeSchema = String(schema).replace(/'/g, "''");
  const safeTable = String(table).replace(/'/g, "''");

  const result = await executeQuery(
    `SELECT
       c.column_name,
       c.data_type,
       c.udt_name,
       c.is_nullable,
       (pk.column_name IS NOT NULL) AS is_primary_key
     FROM information_schema.columns c
     LEFT JOIN (
       SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
        AND kcu.table_name = tc.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = '${safeSchema}'
         AND tc.table_name = '${safeTable}'
     ) pk ON pk.column_name = c.column_name
     WHERE c.table_schema = '${safeSchema}'
       AND c.table_name = '${safeTable}'
     ORDER BY c.ordinal_position;`,
    { databaseName: dbName },
  );

  if (!result.success || !result.data) return [];

  const rows: Array<{
    column_name: string;
    data_type: string;
    udt_name?: string;
    is_nullable: string;
    is_primary_key: boolean;
  }> = result.data;

  return rows
    .filter(r => !!r.column_name)
    .map<DatabaseTreeNode>(r => {
      // information_schema reports "USER-DEFINED" / "ARRAY" for enums and
      // arrays; udt_name carries the real type (e.g. my_enum, _int4).
      const dataType =
        r.data_type === "USER-DEFINED" || r.data_type === "ARRAY"
          ? r.udt_name
            ? r.data_type === "ARRAY"
              ? `${r.udt_name.replace(/^_/, "")}[]`
              : r.udt_name
            : r.data_type
          : r.data_type;
      return {
        id: `${dbName ? dbName + "." : ""}${schema}.${table}.${r.column_name}`,
        label: r.column_name,
        kind: "column",
        hasChildren: false,
        metadata: {
          schema,
          table,
          columnName: r.column_name,
          columnType: dataType,
          isNullable: r.is_nullable === "YES",
          isPrimaryKey: r.is_primary_key === true,
          databaseId: dbName,
          databaseName: dbName,
        },
      };
    });
}
