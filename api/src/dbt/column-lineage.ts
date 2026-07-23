/**
 * Inferred column-level lineage for the Transforms DAG.
 *
 * dbt Core manifests do not ship true column→column edges. v1 infers edges by
 * matching column names (case-insensitive) across each table-level parent_map
 * edge. Callers should label these as inferred, not guaranteed.
 */

export interface LineageColumn {
  name: string;
  type?: string;
  description?: string;
}

export interface LineageTableEdge {
  source: string;
  target: string;
}

export interface ColumnLineageEdge {
  sourceNodeId: string;
  sourceColumn: string;
  targetNodeId: string;
  targetColumn: string;
  confidence: "name_match";
}

export interface CatalogNodeColumns {
  columns?: Record<string, { type?: string; comment?: string | null }>;
}

/**
 * Merge warehouse types from `catalog.json` into YAML/docs columns. Catalog-
 * only columns (undocumented in schema.yml) are appended so name-match lineage
 * can still connect them.
 */
export function mergeCatalogColumns(
  columns: LineageColumn[],
  catalogEntry: CatalogNodeColumns | undefined,
): LineageColumn[] {
  if (!catalogEntry?.columns) return columns;
  const byName = new Map(
    columns.map(col => [col.name.toLowerCase(), { ...col }]),
  );
  for (const [rawName, meta] of Object.entries(catalogEntry.columns)) {
    const key = rawName.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      if (!existing.type && meta.type) existing.type = meta.type;
      if (!existing.description && meta.comment) {
        existing.description = meta.comment;
      }
    } else {
      byName.set(key, {
        name: rawName,
        type: meta.type || undefined,
        description: meta.comment || undefined,
      });
    }
  }
  return Array.from(byName.values());
}

/**
 * For each table edge parent→child, emit a column edge for every shared
 * column name (case-insensitive). Uses the child's casing for the target
 * and the parent's casing for the source.
 */
export function buildNameMatchColumnEdges(
  nodes: Array<{ id: string; columns?: LineageColumn[] }>,
  tableEdges: LineageTableEdge[],
): ColumnLineageEdge[] {
  const columnsByNode = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const map = new Map<string, string>();
    for (const col of node.columns ?? []) {
      if (!col.name) continue;
      const key = col.name.toLowerCase();
      if (!map.has(key)) map.set(key, col.name);
    }
    columnsByNode.set(node.id, map);
  }

  const edges: ColumnLineageEdge[] = [];
  const seen = new Set<string>();
  for (const edge of tableEdges) {
    const parentCols = columnsByNode.get(edge.source);
    const childCols = columnsByNode.get(edge.target);
    if (!parentCols || !childCols) continue;
    for (const [key, parentName] of parentCols) {
      const childName = childCols.get(key);
      if (!childName) continue;
      const id = `${edge.source}.${key}->${edge.target}.${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({
        sourceNodeId: edge.source,
        sourceColumn: parentName,
        targetNodeId: edge.target,
        targetColumn: childName,
        confidence: "name_match",
      });
    }
  }
  return edges;
}
