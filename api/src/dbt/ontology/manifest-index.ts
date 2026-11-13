/**
 * A compact, searchable index of one dbt manifest: what models, sources and
 * seeds exist, what they mean and how they connect.
 *
 * The manifest dbt writes holds every node's raw and compiled SQL and runs
 * to tens of megabytes on a large project. This module keeps only what an
 * agent asks about before writing SQL (names, descriptions, columns, tests,
 * lineage, relation names) so the parsed manifest can be dropped and the
 * index cached. Pure: no I/O.
 */
import { tokenMatch, tokenize } from "../../apps/app-search";

// ---------------------------------------------------------------------------
// The parts of dbt's artifacts this module reads
// ---------------------------------------------------------------------------

interface RawColumn {
  name?: string;
  description?: string;
  data_type?: string | null;
  meta?: Record<string, unknown>;
}

interface RawNode {
  name?: string;
  alias?: string;
  resource_type?: string;
  package_name?: string;
  original_file_path?: string;
  description?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  group?: string | null;
  access?: string | null;
  relation_name?: string | null;
  database?: string | null;
  schema?: string | null;
  identifier?: string | null;
  source_name?: string;
  columns?: Record<string, RawColumn>;
  config?: {
    materialized?: string;
    meta?: Record<string, unknown>;
    contract?: { enforced?: boolean };
    group?: string | null;
    access?: string | null;
  };
  contract?: { enforced?: boolean };
  depends_on?: { nodes?: string[] };
  // Tests only.
  attached_node?: string | null;
  column_name?: string | null;
  test_metadata?: { name?: string; namespace?: string | null };
}

interface RawExposure {
  name?: string;
  label?: string;
  type?: string;
  url?: string;
  description?: string;
  owner?: { name?: string; email?: string };
  depends_on?: { nodes?: string[] };
}

export interface RawManifest {
  metadata?: { generated_at?: string; project_name?: string };
  nodes?: Record<string, RawNode>;
  sources?: Record<string, RawNode>;
  exposures?: Record<string, RawExposure>;
  parent_map?: Record<string, string[]>;
  child_map?: Record<string, string[]>;
}

export interface RawCatalog {
  nodes?: Record<string, RawCatalogNode>;
  sources?: Record<string, RawCatalogNode>;
}

interface RawCatalogNode {
  columns?: Record<string, { name?: string; type?: string; index?: number }>;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export type IndexedResourceType = "model" | "seed" | "snapshot" | "source";

export interface IndexedColumn {
  name: string;
  description?: string;
  /** From catalog.json when present, else the manifest's `data_type`. */
  type?: string;
  tests: string[];
}

export interface IndexedExposure {
  name: string;
  type?: string;
  url?: string;
  owner?: string;
}

export interface IndexedNode {
  /** dbt unique id, e.g. `model.analytics.fct_orders`. */
  id: string;
  /** Model name, or `<source>.<table>` for a source. */
  name: string;
  resourceType: IndexedResourceType;
  /** `staging`, `intermediate`, `marts`, …, or `source` / `seed`. */
  layer: string;
  path?: string;
  description?: string;
  grain?: string;
  tags: string[];
  meta: Record<string, unknown>;
  group?: string;
  access?: string;
  contractEnforced?: boolean;
  materialized?: string;
  /** As dbt wrote it, quoting included. */
  relationName?: string;
  /** Unquoted, lowercased `database.schema.table`, for matching. */
  relationKey?: string;
  /** The table part of the relation, lowercased. */
  relationTable: string;
  columns: IndexedColumn[];
  /** Tests on the whole node (no column). */
  tests: string[];
  parents: string[];
  children: string[];
  exposures: IndexedExposure[];
}

export interface ManifestIndex {
  generatedAt?: string;
  projectName?: string;
  /** Whether column types came from a catalog.json. */
  hasCatalog: boolean;
  nodes: IndexedNode[];
  byId: Map<string, IndexedNode>;
}

const NODE_TYPES = new Set(["model", "seed", "snapshot"]);

/** `` `p`.`d`.`t` `` / `"d"."s"."t"` / `[d].[s].[t]` → `p.d.t`, lowercased. */
export function normalizeRelation(relation: string): string {
  return relation
    .replace(/\{\{\s*dbt_schema\s*\}\}/gi, "{{dbt_schema}}")
    .replace(/[`"[\]\s]/g, "")
    .toLowerCase();
}

const LAYER_ALIASES: Record<string, string> = {
  stg: "staging",
  staging: "staging",
  int: "intermediate",
  intermediate: "intermediate",
  mart: "marts",
  marts: "marts",
  fct: "marts",
  dim: "marts",
  source: "source",
  sources: "source",
  seed: "seed",
  seeds: "seed",
  snapshot: "snapshot",
  snapshots: "snapshot",
};

/** `stg` / `Staging` / `sources` → the layer name the index uses. */
export function normalizeLayer(layer: string): string {
  const key = layer.trim().toLowerCase().replace(/\/+$/, "");
  return LAYER_ALIASES[key] ?? key;
}

function layerOf(
  resourceType: IndexedResourceType,
  path: string | undefined,
  name: string,
): string {
  if (resourceType !== "model") return resourceType;
  const segments = (path ?? "").split("/").filter(Boolean);
  // `models/marts/finance/fct_x.sql` → `marts`; a model directly under
  // `models/` has no folder to name its layer, so the prefix decides.
  if (segments[0] === "models" && segments.length > 2) return segments[1];
  const prefix = /^([a-z]+)_/.exec(name.toLowerCase())?.[1];
  return (prefix && LAYER_ALIASES[prefix]) || "models";
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

/**
 * The grain a node states: `meta.grain` (a string or a list of keys), else a
 * sentence of the description that starts with "Grain:" or "One row per".
 */
export function statedGrain(
  meta: Record<string, unknown>,
  description: string | undefined,
): string | undefined {
  const fromMeta = meta.grain;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    return fromMeta.map(String).join(" x ");
  }
  if (!description) return undefined;
  const labelled = /\bgrain\s*(?:is|:|=)\s*([^.\n]+)/i.exec(description);
  if (labelled) return truncateText(labelled[1], 160);
  const rowPer = /\b(one row per [^.\n]+)/i.exec(description);
  return rowPer ? truncateText(rowPer[1], 160) : undefined;
}

function testLabel(test: RawNode): string {
  const name = test.test_metadata?.name;
  if (!name) return test.name ?? "test";
  const namespace = test.test_metadata?.namespace;
  return namespace ? `${namespace}.${name}` : name;
}

/** Build the index. `catalog` adds column types and undocumented columns. */
export function buildManifestIndex(
  manifest: RawManifest,
  catalog?: RawCatalog | null,
): ManifestIndex {
  const nodes: IndexedNode[] = [];
  const byId = new Map<string, IndexedNode>();

  const add = (
    id: string,
    raw: RawNode,
    resourceType: IndexedResourceType,
    catalogNode: RawCatalogNode | undefined,
  ) => {
    const baseName = raw.name ?? id.split(".").pop() ?? id;
    const name =
      resourceType === "source" && raw.source_name
        ? `${raw.source_name}.${baseName}`
        : baseName;
    const meta = { ...(raw.config?.meta ?? {}), ...(raw.meta ?? {}) };
    const description = cleanText(raw.description);
    const relationKey = raw.relation_name
      ? normalizeRelation(raw.relation_name)
      : undefined;
    const relationTable = (
      relationKey?.split(".").pop() ??
      raw.identifier ??
      raw.alias ??
      baseName
    ).toLowerCase();

    const catalogColumns = new Map(
      Object.values(catalogNode?.columns ?? {}).map(col => [
        (col.name ?? "").toLowerCase(),
        col,
      ]),
    );
    const columns: IndexedColumn[] = [];
    const seenColumns = new Set<string>();
    for (const [key, col] of Object.entries(raw.columns ?? {})) {
      const colName = col.name ?? key;
      const lower = colName.toLowerCase();
      seenColumns.add(lower);
      const type =
        cleanText(catalogColumns.get(lower)?.type) ?? cleanText(col.data_type);
      columns.push({
        name: colName,
        ...(cleanText(col.description)
          ? { description: cleanText(col.description) }
          : {}),
        ...(type ? { type } : {}),
        tests: [],
      });
    }
    // Columns the warehouse has and the YAML does not document.
    const undocumented = [...catalogColumns.values()]
      .filter(col => col.name && !seenColumns.has(col.name.toLowerCase()))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const col of undocumented) {
      columns.push({
        name: col.name as string,
        ...(cleanText(col.type) ? { type: cleanText(col.type) } : {}),
        tests: [],
      });
    }

    const contract = raw.contract?.enforced ?? raw.config?.contract?.enforced;
    const node: IndexedNode = {
      id,
      name,
      resourceType,
      layer: layerOf(resourceType, raw.original_file_path, baseName),
      ...(raw.original_file_path ? { path: raw.original_file_path } : {}),
      ...(description ? { description } : {}),
      ...(statedGrain(meta, description)
        ? { grain: statedGrain(meta, description) }
        : {}),
      tags: raw.tags ?? [],
      meta,
      ...(cleanText(raw.group ?? raw.config?.group)
        ? { group: cleanText(raw.group ?? raw.config?.group) }
        : {}),
      ...(cleanText(raw.access ?? raw.config?.access)
        ? { access: cleanText(raw.access ?? raw.config?.access) }
        : {}),
      ...(contract !== undefined ? { contractEnforced: contract } : {}),
      ...(raw.config?.materialized
        ? { materialized: raw.config.materialized }
        : {}),
      ...(raw.relation_name ? { relationName: raw.relation_name } : {}),
      ...(relationKey ? { relationKey } : {}),
      relationTable,
      columns,
      tests: [],
      parents: [],
      children: [],
      exposures: [],
    };
    nodes.push(node);
    byId.set(id, node);
  };

  for (const [id, raw] of Object.entries(manifest.nodes ?? {})) {
    const type = raw.resource_type ?? id.split(".")[0];
    if (!NODE_TYPES.has(type)) continue;
    add(id, raw, type as IndexedResourceType, catalog?.nodes?.[id]);
  }
  for (const [id, raw] of Object.entries(manifest.sources ?? {})) {
    add(id, raw, "source", catalog?.sources?.[id]);
  }

  // Tests: attach each to the node (and column) it checks.
  for (const [id, raw] of Object.entries(manifest.nodes ?? {})) {
    if ((raw.resource_type ?? id.split(".")[0]) !== "test") continue;
    const deps = raw.depends_on?.nodes ?? [];
    const targetId = raw.attached_node ?? (deps.length === 1 ? deps[0] : null);
    const target = targetId ? byId.get(targetId) : undefined;
    if (!target) continue;
    const label = testLabel(raw);
    const column = raw.column_name
      ? target.columns.find(
          col => col.name.toLowerCase() === raw.column_name?.toLowerCase(),
        )
      : undefined;
    const list = column ? column.tests : target.tests;
    if (!list.includes(label)) list.push(label);
  }

  // Lineage between indexed nodes only (tests and macros are not lineage).
  const link = (parentId: string, childId: string) => {
    const parent = byId.get(parentId);
    const child = byId.get(childId);
    if (!parent || !child || parent === child) return;
    if (!child.parents.includes(parent.name)) child.parents.push(parent.name);
    if (!parent.children.includes(child.name)) parent.children.push(child.name);
  };
  if (manifest.parent_map) {
    for (const [childId, parents] of Object.entries(manifest.parent_map)) {
      for (const parentId of parents) link(parentId, childId);
    }
  } else {
    for (const [childId, raw] of Object.entries(manifest.nodes ?? {})) {
      for (const parentId of raw.depends_on?.nodes ?? []) {
        link(parentId, childId);
      }
    }
  }

  for (const [id, exposure] of Object.entries(manifest.exposures ?? {})) {
    const owner = exposure.owner?.name || exposure.owner?.email;
    const entry: IndexedExposure = {
      name: exposure.label || exposure.name || id,
      ...(exposure.type ? { type: exposure.type } : {}),
      ...(exposure.url ? { url: exposure.url } : {}),
      ...(owner ? { owner } : {}),
    };
    const deps = exposure.depends_on?.nodes ?? manifest.parent_map?.[id] ?? [];
    for (const dep of deps) byId.get(dep)?.exposures.push(entry);
  }

  for (const node of nodes) {
    node.parents.sort();
    node.children.sort();
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...(manifest.metadata?.generated_at
      ? { generatedAt: manifest.metadata.generated_at }
      : {}),
    ...(manifest.metadata?.project_name
      ? { projectName: manifest.metadata.project_name }
      : {}),
    hasCatalog: !!catalog,
    nodes,
    byId,
  };
}

// ---------------------------------------------------------------------------
// Resolving a name
// ---------------------------------------------------------------------------

/**
 * The nodes a name refers to: a dbt unique id, a model/seed name, a source
 * as `<source>.<table>`, or a warehouse relation (`dataset.table`,
 * `project.dataset.table`, quoted or not). Usually one; more when a bare
 * table name is both a source and a model.
 */
export function resolveNodes(
  index: ManifestIndex,
  name: string,
): IndexedNode[] {
  const exact = index.byId.get(name.trim());
  if (exact) return [exact];
  const key = normalizeRelation(name);
  if (!key) return [];
  const byName = index.nodes.filter(node => node.name.toLowerCase() === key);
  if (byName.length > 0) return byName;
  const parts = key.split(".");
  if (parts.length >= 2) {
    const byRelation = index.nodes.filter(
      node =>
        node.relationKey !== undefined &&
        (node.relationKey === key ||
          node.relationKey.endsWith(`.${key}`) ||
          key.endsWith(`.${node.relationKey}`)),
    );
    if (byRelation.length > 0) return byRelation;
  }
  // A bare table name: the source's table, or a model's alias.
  if (parts.length === 1) {
    return index.nodes.filter(
      node =>
        node.relationTable === key ||
        (node.resourceType === "source" && node.name.split(".").pop() === key),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface ModelSearchHit {
  node: IndexedNode;
  score: number;
  matchedOn: string[];
}

/** Extra words a node answers to, e.g. the registry synonyms of its terms. */
export type ExtraSearchWords = (node: IndexedNode) => string;

const SEARCH_FIELDS: Array<{
  name: string;
  weight: number;
  text: (node: IndexedNode, extra?: ExtraSearchWords) => string;
}> = [
  { name: "name", weight: 6, text: n => n.name },
  { name: "registry", weight: 6, text: (n, extra) => extra?.(n) ?? "" },
  {
    name: "columns",
    weight: 3,
    text: n => n.columns.map(c => c.name).join(" "),
  },
  { name: "description", weight: 2, text: n => n.description ?? "" },
  { name: "tags", weight: 2, text: n => n.tags.join(" ") },
  { name: "meta", weight: 2, text: n => metaText(n.meta) },
  {
    name: "column_descriptions",
    weight: 1,
    text: n => n.columns.map(c => c.description ?? "").join(" "),
  },
  { name: "path", weight: 1, text: n => n.path ?? "" },
];

function metaText(meta: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (!Array.isArray(value)) out.push(key);
        walk(inner, depth + 1);
      }
      return;
    }
    out.push(String(value));
  };
  walk(meta, 0);
  return out.join(" ");
}

/**
 * Every node the query's words match, best first. Each query word counts
 * once, at its best field; a node matching all of the query ranks above one
 * matching a single word many times. `layer` keeps one layer (`staging`,
 * `marts`, `source`, `seed`, or a folder under `models/`).
 */
export function searchNodes(
  index: ManifestIndex,
  query: string,
  options: { layer?: string; extraWords?: ExtraSearchWords } = {},
): ModelSearchHit[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const layer = options.layer ? normalizeLayer(options.layer) : undefined;
  const phrase = normalizeRelation(query);
  const hits: ModelSearchHit[] = [];
  for (const node of index.nodes) {
    if (layer && !inLayer(node, layer)) continue;
    const fields = SEARCH_FIELDS.map(field => ({
      name: field.name,
      weight: field.weight,
      words: tokenize(field.text(node, options.extraWords)),
    }));
    let score = 0;
    let matched = 0;
    const matchedOn = new Set<string>();
    for (const token of tokens) {
      let best = 0;
      for (const field of fields) {
        const m = tokenMatch(token, field.words) * field.weight;
        if (m > 0) matchedOn.add(field.name);
        best = Math.max(best, m);
      }
      if (best > 0) matched++;
      score += best;
    }
    if (matched === 0) continue;
    score *= matched / tokens.length;
    // The query IS the model's name (or its relation): nothing ranks above.
    if (node.name.toLowerCase() === phrase || node.relationKey === phrase) {
      score += 20;
    }
    hits.push({
      node,
      score: Math.round(score * 100) / 100,
      matchedOn: [...matchedOn],
    });
  }
  return hits.sort(
    (a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name),
  );
}

function inLayer(node: IndexedNode, layer: string): boolean {
  if (normalizeLayer(node.layer) === layer) return true;
  return (node.path ?? "").toLowerCase().split("/").includes(layer);
}

// ---------------------------------------------------------------------------
// Compacting text for a tool result
// ---------------------------------------------------------------------------

/** Cut text at `max` characters, on a word where possible, marking the cut. */
export function truncateText(
  text: string | undefined,
  max: number,
): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}… [truncated]`;
}

/** The first `max` items and how many there were in all. */
export function capList<T>(
  items: readonly T[],
  max: number,
): { items: T[]; total: number; truncated: boolean } {
  return {
    items: items.slice(0, max),
    total: items.length,
    truncated: items.length > max,
  };
}
