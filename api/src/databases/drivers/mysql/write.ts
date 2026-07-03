/**
 * MySQL write-dialect helpers (destination sync + CDC adapter support).
 *
 * Pure SQL builders — the driver calls executeQuery with these strings, so
 * the offline write-sql tests can assert the generated SQL with no database.
 *
 * MySQL specifics handled here:
 * - Identifiers quote with backticks.
 * - TEXT/BLOB columns cannot be indexed without a key-prefix length, so
 *   unique/secondary indexes use a 191-char prefix for text-ish columns
 *   (fits InnoDB's 767-byte limit under utf8mb4).
 * - Upserts use `INSERT ... AS new ON DUPLICATE KEY UPDATE` (MySQL 8.0.19+;
 *   the legacy VALUES() syntax was removed in MySQL 8.4).
 * - Out-of-order protection: each column updates through
 *   IF(<newer-than-current>, new.col, col); the ordering columns themselves
 *   are assigned LAST so the guards evaluate against the pre-update row
 *   (ON DUPLICATE KEY UPDATE assignments apply left to right).
 * - DATETIME literals use 'YYYY-MM-DD HH:MM:SS.mmm' (UTC, no zone suffix).
 */
import type { ColumnDefinition } from "../../driver";

export function escapeIdentifier(name: string): string {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

export function escapeSqlLiteral(value: string): string {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function formatDateTimeLiteral(date: Date): string {
  return `'${date.toISOString().replace("T", " ").replace("Z", "")}'`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return formatDateTimeLiteral(value);
  if (typeof value === "object") {
    return escapeSqlLiteral(JSON.stringify(value));
  }
  // ISO timestamps arrive as strings from connector payloads; MySQL DATETIME
  // rejects the trailing 'Z', so normalize when the shape matches.
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
  ) {
    return formatDateTimeLiteral(new Date(value));
  }
  return escapeSqlLiteral(String(value));
}

export function inferMySqlType(value: unknown): string {
  if (value === null || value === undefined) return "TEXT";
  if (typeof value === "boolean") return "TINYINT(1)";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "BIGINT" : "DOUBLE";
  }
  if (typeof value === "bigint") return "BIGINT";
  if (value instanceof Date) return "DATETIME(3)";
  if (typeof value === "object") return "JSON";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return "DATETIME(3)";
    }
    return "TEXT";
  }
  return "TEXT";
}

const TEXTY_TYPE = /TEXT|BLOB|CHAR|JSON/i;

/** Index part with a key-prefix length for text-ish column types. */
export function indexPart(column: string, columnType?: string): string {
  const ident = escapeIdentifier(column);
  if (!columnType || TEXTY_TYPE.test(columnType)) {
    return `${ident}(191)`;
  }
  return ident;
}

export function qualifiedTable(schema: string, tableName: string): string {
  return `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;
}

export function buildCreateTableSql(
  schema: string,
  tableName: string,
  columns: ColumnDefinition[],
): string {
  const columnDefs = columns.map(col => {
    let def = `${escapeIdentifier(col.name)} ${col.type}`;
    if (col.primaryKey) {
      // TEXT cannot be a bare PRIMARY KEY in MySQL — use a prefixed unique
      // index instead (created separately) and keep the column plain here.
      if (!TEXTY_TYPE.test(col.type)) def += " PRIMARY KEY";
    } else if (!col.nullable) {
      def += " NOT NULL";
    }
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS ${qualifiedTable(schema, tableName)} (\n  ${columnDefs.join(",\n  ")}\n)`;
}

export function buildInsertSql(
  schema: string,
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  options?: { ignore?: boolean },
): string {
  const columnList = columns.map(escapeIdentifier).join(", ");
  const valueRows = rows.map(
    row => `(${columns.map(col => formatValue(row[col])).join(", ")})`,
  );
  const verb = options?.ignore ? "INSERT IGNORE" : "INSERT";
  return `${verb} INTO ${qualifiedTable(schema, tableName)} (${columnList}) VALUES\n${valueRows.join(",\n")}`;
}

export const ORDERING_COLUMNS = ["_mako_source_ts", "_mako_ingest_seq"];

export function buildUpsertSql(
  schema: string,
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  keyColumns: string[],
): string {
  const columnList = columns.map(escapeIdentifier).join(", ");
  const valueRows = rows.map(
    row => `(${columns.map(col => formatValue(row[col])).join(", ")})`,
  );

  const hasSourceOrdering =
    columns.includes("_mako_source_ts") &&
    !keyColumns.includes("_mako_source_ts");
  const hasIngestOrdering =
    columns.includes("_mako_ingest_seq") &&
    !keyColumns.includes("_mako_ingest_seq");

  // With the `AS new` row alias, unqualified column references in the UPDATE
  // expressions are ambiguous (both the table and the alias expose them), so
  // current-row reads must be table-qualified.
  const current = (column: string) =>
    `${escapeIdentifier(tableName)}.${escapeIdentifier(column)}`;

  // Guard references the CURRENT row values, so the ordering columns must be
  // assigned last (assignments apply left to right).
  const guard = hasSourceOrdering
    ? `COALESCE(\`new\`.${escapeIdentifier("_mako_source_ts")}, '1970-01-01') >= COALESCE(${current("_mako_source_ts")}, '1970-01-01')`
    : hasIngestOrdering
      ? `COALESCE(\`new\`.${escapeIdentifier("_mako_ingest_seq")}, -1) >= COALESCE(${current("_mako_ingest_seq")}, -1)`
      : "";

  const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
  const orderedForUpdate = [
    ...nonKeyColumns.filter(c => !ORDERING_COLUMNS.includes(c)),
    ...nonKeyColumns.filter(c => ORDERING_COLUMNS.includes(c)),
  ];

  const updates = orderedForUpdate
    .map(c => {
      const ident = escapeIdentifier(c);
      const incoming = `\`new\`.${ident}`;
      return guard
        ? `${ident} = IF(${guard}, ${incoming}, ${current(c)})`
        : `${ident} = ${incoming}`;
    })
    .join(", ");

  if (!updates) {
    return buildInsertSql(schema, tableName, columns, rows, { ignore: true });
  }

  return `INSERT INTO ${qualifiedTable(schema, tableName)} (${columnList}) VALUES\n${valueRows.join(",\n")}\nAS \`new\` ON DUPLICATE KEY UPDATE ${updates}`;
}

export function buildDeleteSql(
  schema: string,
  tableName: string,
  keyFilters: Record<string, unknown>,
): string {
  const whereClause = Object.entries(keyFilters)
    .filter(([, value]) => value !== undefined)
    .map(([column, value]) =>
      value === null
        ? `${escapeIdentifier(column)} IS NULL`
        : `${escapeIdentifier(column)} = ${formatValue(value)}`,
    )
    .join(" AND ");
  return `DELETE FROM ${qualifiedTable(schema, tableName)} WHERE ${whereClause}`;
}

export function buildUniqueIndexSql(
  schema: string,
  tableName: string,
  keyColumns: string[],
  columnTypes: Map<string, string>,
): { indexName: string; sql: string } {
  const rawIndexName = `${tableName}_${keyColumns.join("_")}_cdc_uidx`
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase()
    .slice(0, 64);
  const parts = keyColumns
    .map(col => indexPart(col, columnTypes.get(col.toLowerCase())))
    .join(", ");
  return {
    indexName: rawIndexName,
    sql: `CREATE UNIQUE INDEX ${escapeIdentifier(rawIndexName)} ON ${qualifiedTable(schema, tableName)} (${parts})`,
  };
}

/**
 * Layout hints (partition field + cluster fields) map to plain secondary
 * indexes on MySQL — same concept as the Postgres mapping.
 */
export function buildMySqlLayoutIndexes(
  layout: {
    tableName: string;
    keyColumns?: string[];
    partitioning?: { field?: string };
    clustering?: { fields?: string[] };
  },
  schema: string,
  columnTypes: Map<string, string>,
): Array<{ indexName: string; sql: string }> {
  const fields = new Set<string>();
  if (layout.partitioning?.field) fields.add(layout.partitioning.field);
  for (const field of layout.clustering?.fields || []) fields.add(field);
  for (const key of layout.keyColumns || []) fields.delete(key);

  return [...fields].map(field => {
    const indexName = `mako_layout_${layout.tableName}_${field}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64);
    return {
      indexName,
      sql: `CREATE INDEX ${escapeIdentifier(indexName)} ON ${qualifiedTable(schema, layout.tableName)} (${indexPart(field, columnTypes.get(field.toLowerCase()))})`,
    };
  });
}
