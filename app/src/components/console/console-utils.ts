import type { AutocompleteSchema } from "../../store/schemaStore";

/** Editor language: from the file extension, else the connection type. */
export function consoleEditorLanguage(
  filePath: string | undefined,
  dbType: string | undefined,
): string {
  if (filePath?.endsWith(".sql")) return "sql";
  if (filePath?.endsWith(".json")) return "json";
  if (filePath?.endsWith(".js") || filePath?.endsWith(".ts")) {
    return "javascript";
  }
  return dbType === "mongodb" ? "javascript" : "sql";
}

export interface UnknownTableRef {
  /** Offset of the table name in the content. */
  start: number;
  end: number;
  /** The name without backticks, as shown in the warning. */
  name: string;
}

/**
 * Table references in FROM/JOIN clauses that the connection's autocomplete
 * schema does not know (1-, 2- or 3-part names; `project.dataset.table`
 * matches on dataset + table). Templated names (`{`, `$`) are skipped.
 */
export function findUnknownTableRefs(
  content: string,
  schema: AutocompleteSchema,
): UnknownTableRef[] {
  const refs: UnknownTableRef[] = [];
  // Simple regex to find table references in FROM/JOIN clauses
  const tableRegex = /(?:FROM|JOIN)\s+([^\s,;()]+)(?:\s+AS\s+\w+)?/gi;
  let match;

  while ((match = tableRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const tableNameRaw = match[1];

    // Skip if it contains template variables or special chars
    if (tableNameRaw.includes("{") || tableNameRaw.includes("$")) continue;

    const cleanRaw = tableNameRaw.replace(/`/g, "");
    const parts = cleanRaw.split(".");

    let isValid = false;
    if (parts.length === 1) {
      const table = parts[0];
      isValid = Object.keys(schema).some(ds => Boolean(schema[ds][table]));
    } else if (parts.length === 2) {
      const [ds, table] = parts;
      isValid = Boolean(schema[ds] && schema[ds][table]);
    } else if (parts.length === 3) {
      const [, ds, table] = parts;
      isValid = Boolean(schema[ds] && schema[ds][table]);
    }

    if (!isValid && parts.length <= 3) {
      const tableIndex = fullMatch.indexOf(tableNameRaw);
      if (tableIndex !== -1) {
        const start = match.index + tableIndex;
        refs.push({ start, end: start + tableNameRaw.length, name: cleanRaw });
      }
    }
  }
  return refs;
}
