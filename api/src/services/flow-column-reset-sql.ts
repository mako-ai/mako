/**
 * The SQL a CDC column reset runs: NULL one destination column and, to force
 * a replay, rewind the row's source timestamp and ingest sequence so the next
 * backfill wins every LWW comparison. Pure — no driver, no connection.
 */

export function escapePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function escapeBigQueryPath(path: string): string {
  return `\`${path.replace(/`/g, "\\`")}\``;
}

export function isSafeSqlIdentifier(identifier: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier);
}

/** The UPDATE that NULLs `column` (and rewinds the replay guards), or null. */
export function buildColumnResetQuery(params: {
  destinationType: string;
  projectId?: string;
  schema: string;
  tableName: string;
  column: string;
  forceReplay: boolean;
}): string | null {
  const { destinationType, schema, tableName, column, forceReplay } = params;
  if (destinationType === "bigquery") {
    const projectId = params.projectId ?? "";
    const tableRef = projectId
      ? `${projectId}.${schema}.${tableName}`
      : `${schema}.${tableName}`;
    const assignments = [`${escapeBigQueryPath(column)} = NULL`];
    if (forceReplay) {
      assignments.push(
        `${escapeBigQueryPath("_mako_source_ts")} = TIMESTAMP('1970-01-01 00:00:00 UTC')`,
      );
      assignments.push(`${escapeBigQueryPath("_mako_ingest_seq")} = -1`);
    }
    return `UPDATE ${escapeBigQueryPath(tableRef)} SET ${assignments.join(", ")} WHERE TRUE`;
  }
  if (destinationType.includes("postgres")) {
    const assignments = [`${escapePostgresIdentifier(column)} = NULL`];
    if (forceReplay) {
      assignments.push(
        `${escapePostgresIdentifier("_mako_source_ts")} = TIMESTAMP '1970-01-01 00:00:00+00'`,
      );
      assignments.push(`${escapePostgresIdentifier("_mako_ingest_seq")} = -1`);
    }
    return `UPDATE ${escapePostgresIdentifier(schema)}.${escapePostgresIdentifier(tableName)} SET ${assignments.join(", ")}`;
  }
  return null;
}
