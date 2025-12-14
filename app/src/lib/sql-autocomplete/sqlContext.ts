export type SqlTableRef = {
  dataset?: string;
  table: string;
};

export type SqlParseResult = {
  aliasMap: Map<string, SqlTableRef>;
  refs: SqlTableRef[];
  lastTable: SqlTableRef | null;
};

export function stripSqlIdentifierQuotes(value: string) {
  return String(value || "").replace(/[`"]/g, "");
}

export function parseTableContext(sql: string): SqlParseResult {
  // FROM <ident> [AS alias]
  // JOIN <ident> [AS alias]
  // Note: we intentionally keep this lightweight (no full SQL parser)
  const tableRegex = /(?:FROM|JOIN)\s+([`"\w.-]+)(?:\s+(?:AS\s+)?([`"\w]+))?/gi;

  const aliasMap = new Map<string, SqlTableRef>();
  const refs: SqlTableRef[] = [];
  const seen = new Set<string>();
  let lastTable: SqlTableRef | null = null;

  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(sql)) !== null) {
    const rawIdent = stripSqlIdentifierQuotes(match[1] || "");
    const rawAlias = stripSqlIdentifierQuotes(match[2] || "");
    if (!rawIdent) continue;

    const parts = rawIdent.split(".");
    // BigQuery frequently uses project.dataset.table; treat the last 2 segments as dataset/table
    const dataset =
      parts.length >= 3
        ? parts[parts.length - 2]
        : parts.length === 2
          ? parts[0]
          : undefined;
    const table = parts.length >= 2 ? parts[parts.length - 1] : parts[0];

    const ref: SqlTableRef = { dataset, table };
    lastTable = ref;

    const refKey = `${dataset || ""}.${table}`;
    if (!seen.has(refKey)) {
      refs.push(ref);
      seen.add(refKey);
    }

    if (rawAlias) {
      aliasMap.set(rawAlias, ref);
    }
    // Provide a default "alias" mapping for the table name itself
    aliasMap.set(table, ref);
  }

  return { aliasMap, refs, lastTable };
}

export function getFromOrJoinToken(textUntilCursor: string): string | null {
  const m = textUntilCursor.match(/(?:FROM|JOIN)\s+([^\s;]*)$/i);
  if (!m) return null;
  return String(m[1] || "");
}

export function getDotContext(
  textUntilCursor: string,
): { kind: "dot"; datasetId?: string; tableId?: string; ident: string } | null {
  if (!textUntilCursor.endsWith(".")) return null;

  // project.dataset.table.
  const pdt = textUntilCursor.match(/([`"\w-]+)\.([`"\w-]+)\.([`"\w-]+)\.$/);
  if (pdt) {
    return {
      kind: "dot",
      datasetId: stripSqlIdentifierQuotes(pdt[2] || ""),
      tableId: stripSqlIdentifierQuotes(pdt[3] || ""),
      ident: stripSqlIdentifierQuotes(pdt[3] || ""),
    };
  }

  // dataset.table.
  const dt = textUntilCursor.match(/([`"\w-]+)\.([`"\w-]+)\.$/);
  if (dt) {
    return {
      kind: "dot",
      datasetId: stripSqlIdentifierQuotes(dt[1] || ""),
      tableId: stripSqlIdentifierQuotes(dt[2] || ""),
      ident: stripSqlIdentifierQuotes(dt[2] || ""),
    };
  }

  // alias.
  const single = textUntilCursor.match(/(`?)([^`.]+)\1\.$/);
  if (!single) return null;

  return {
    kind: "dot",
    ident: stripSqlIdentifierQuotes(single[2] || ""),
  };
}
