/**
 * Table and column descriptions for `inspect_table`.
 *
 * The dbt manifest wins: when the inspected table is the relation of a dbt
 * model, seed or source, its YAML descriptions are what the team wrote for
 * it. Otherwise the warehouse's own descriptions are used where the engine
 * exposes them cheaply (BigQuery INFORMATION_SCHEMA). Best effort: a
 * failure anywhere means "no descriptions", never a failed inspection.
 */
import { loggers } from "../../logging";
import {
  normalizeRelation,
  truncateText,
  type IndexedNode,
  type ManifestIndex,
} from "./manifest-index";
import { loadManifestIndexes } from "./manifest-index.service";

const logger = loggers.api("dbt-ontology");

const TABLE_DESCRIPTION_CHARS = 1000;
const COLUMN_DESCRIPTION_CHARS = 300;

export interface TableDescriptions {
  source: "dbt" | "warehouse";
  description?: string;
  /** Column name (lowercased) → description. */
  columns: Map<string, string>;
  /** The dbt node the table is, when `source` is `dbt`. */
  dbtNode?: { name: string; resourceType: string };
}

/**
 * The dbt node whose warehouse relation is this table. `parts` is the
 * table's address, outermost first (`[project, dataset, table]`,
 * `[database, schema, table]`, `[database, table]`). The whole address is
 * tried first. `schema.table` is tried only when the address or the dbt
 * relation has two parts. A single part, or an address two nodes share,
 * matches nothing.
 */
export function nodeForRelation(
  indexes: readonly ManifestIndex[],
  parts: readonly string[],
): IndexedNode | undefined {
  const clean = parts.map(part => normalizeRelation(part)).filter(Boolean);
  if (clean.length < 2) return undefined;
  const nodes = indexes.flatMap(index => index.nodes);
  const full = clean.join(".");
  const exact = nodes.filter(node => node.relationKey === full);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  // `schema.table` alone is accepted only when one side has no outer part
  // to compare. `appdb.public.users` is not `analytics.public.users`: the
  // same schema and table on another database is another table.
  const tail = clean.slice(-2).join(".");
  const bySuffix = nodes.filter(node => {
    if (node.relationKey === undefined) return false;
    const depth = node.relationKey.split(".").length;
    if (depth >= 3 && clean.length >= 3) return false;
    return node.relationKey === tail || node.relationKey.endsWith(`.${tail}`);
  });
  return bySuffix.length === 1 ? bySuffix[0] : undefined;
}

/** The descriptions a dbt node carries, or null when it documents nothing. */
export function descriptionsOfNode(
  node: IndexedNode,
): TableDescriptions | null {
  const columns = new Map<string, string>();
  for (const column of node.columns) {
    if (column.description) {
      columns.set(column.name.toLowerCase(), column.description);
    }
  }
  if (!node.description && columns.size === 0) return null;
  return {
    source: "dbt",
    ...(node.description ? { description: node.description } : {}),
    columns,
    dbtNode: { name: node.name, resourceType: node.resourceType },
  };
}

/** dbt's descriptions for a table of this workspace, or null. Never throws. */
export async function dbtTableDescriptions(
  workspaceId: string,
  parts: readonly string[],
): Promise<TableDescriptions | null> {
  try {
    const projects = await loadManifestIndexes(workspaceId);
    const node = nodeForRelation(
      projects.map(project => project.index),
      parts,
    );
    return node ? descriptionsOfNode(node) : null;
  } catch (error) {
    logger.warn("dbt descriptions unavailable for inspect_table", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * BigQuery writes a table's `description` option as a SQL string literal
 * (`"Orders, one row per order\nSecond line"`). This is the text inside.
 */
export function parseBigQueryOptionString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  if (!quoted) return text || undefined;
  const inner = quoted[2].replace(/\\(.)/g, (_, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    if (char === "r") return "\r";
    return char;
  });
  return inner.trim() || undefined;
}

/**
 * The rows of the BigQuery description query (inspect_table) as
 * descriptions: the row with an empty `column_name` is the table's.
 */
export function bigQueryDescriptionsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): TableDescriptions | null {
  let description: string | undefined;
  const columns = new Map<string, string>();
  for (const row of rows) {
    const name = typeof row.column_name === "string" ? row.column_name : "";
    if (!name) {
      description = parseBigQueryOptionString(row.description) ?? description;
      continue;
    }
    if (typeof row.description === "string" && row.description.trim()) {
      columns.set(name.toLowerCase(), row.description.trim());
    }
  }
  if (!description && columns.size === 0) return null;
  return {
    source: "warehouse",
    ...(description ? { description } : {}),
    columns,
  };
}

/**
 * Add descriptions to an inspect_table result. Every existing field stays
 * as it was; `description` appears on the table and on each column that has
 * one, with `descriptionSource` saying where they came from.
 */
export function withDescriptions<
  Field extends { name: string },
  Result extends { fields: Field[] },
>(
  result: Result,
  descriptions: TableDescriptions | null,
): Result & {
  description?: string;
  descriptionSource?: "dbt" | "warehouse";
  dbtNode?: { name: string; resourceType: string };
  fields: Array<Field & { description?: string }>;
} {
  if (!descriptions) return result;
  const tableDescription = truncateText(
    descriptions.description,
    TABLE_DESCRIPTION_CHARS,
  );
  return {
    ...result,
    ...(tableDescription ? { description: tableDescription } : {}),
    descriptionSource: descriptions.source,
    ...(descriptions.dbtNode ? { dbtNode: descriptions.dbtNode } : {}),
    fields: result.fields.map(field => {
      const text = truncateText(
        descriptions.columns.get(field.name.toLowerCase()),
        COLUMN_DESCRIPTION_CHARS,
      );
      return text ? { ...field, description: text } : field;
    }),
  };
}
