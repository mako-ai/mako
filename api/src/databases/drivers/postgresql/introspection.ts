import { DatabaseTreeNode } from "../../driver";

type TreeQueryExecutor = (
  query: string,
  options?: { databaseName?: string },
) => Promise<{ success: boolean; data?: any; error?: string }>;

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
