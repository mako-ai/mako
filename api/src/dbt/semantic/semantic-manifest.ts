/**
 * A compact catalog of one dbt semantic manifest: the metrics a project
 * defines for MetricFlow, by name, label, type and inputs.
 *
 * `semantic_manifest.json` is what `dbt parse` writes next to manifest.json.
 * This module reads the part an agent asks about before computing a number
 * ("is there a metric for this, and how is it defined"). What a metric can
 * be grouped by depends on MetricFlow's join resolution and comes from the
 * engine (metricflow.service.ts), not from here. Pure: no I/O.
 */

// ---------------------------------------------------------------------------
// The parts of the semantic manifest this module reads
// ---------------------------------------------------------------------------

interface RawMetricInput {
  name?: string;
  filter?: unknown;
  alias?: string | null;
}

interface RawMetric {
  name?: string;
  description?: string | null;
  label?: string | null;
  type?: string;
  filter?: unknown;
  type_params?: {
    measure?: RawMetricInput | null;
    numerator?: RawMetricInput | null;
    denominator?: RawMetricInput | null;
    expr?: string | null;
    window?: { count?: number; granularity?: string } | null;
    grain_to_date?: string | null;
    metrics?: RawMetricInput[] | null;
    is_private?: boolean | null;
  } | null;
  config?: { meta?: Record<string, unknown> } | null;
}

interface RawSemanticModel {
  name?: string;
  description?: string | null;
  node_relation?: {
    relation_name?: string | null;
    database?: string | null;
  } | null;
}

export interface RawSemanticManifest {
  metrics?: RawMetric[];
  semantic_models?: RawSemanticModel[];
  saved_queries?: Array<{ name?: string }>;
  project_configuration?: {
    time_spines?: unknown[];
    time_spine_table_configurations?: unknown[];
  } | null;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type MetricType =
  "simple" | "ratio" | "derived" | "cumulative" | "conversion" | string;

export interface CatalogMetric {
  name: string;
  label?: string;
  description?: string;
  type: MetricType;
  /** A simple metric's measure. */
  measure?: string;
  /** A ratio metric's two inputs. */
  numerator?: string;
  denominator?: string;
  /** A derived metric's expression and the metrics it reads. */
  expr?: string;
  inputMetrics?: string[];
  /** A cumulative metric's window ("7 day") or grain-to-date ("month"). */
  window?: string;
  grainToDate?: string;
  /** True when the definition carries its own filter. */
  filtered: boolean;
}

export interface SemanticCatalog {
  metrics: CatalogMetric[];
  semanticModels: Array<{
    name: string;
    description?: string;
    relation?: string;
    /** The database (BigQuery: project) the relation lives in. */
    database?: string;
  }>;
  savedQueries: string[];
  /**
   * False when the project declares no time spine: cumulative metrics and
   * joins to the time spine then fail to compile.
   */
  hasTimeSpine: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function hasFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== "object") return false;
  const filters = (filter as { where_filters?: unknown[] }).where_filters;
  return Array.isArray(filters) ? filters.length > 0 : true;
}

function catalogMetric(raw: RawMetric): CatalogMetric | null {
  const name = text(raw.name);
  if (!name) return null;
  const params = raw.type_params ?? {};
  const inputMetrics = (params.metrics ?? [])
    .map(input => text(input?.name))
    .filter((input): input is string => Boolean(input));
  const window =
    params.window?.count && params.window.granularity
      ? `${params.window.count} ${params.window.granularity}`
      : undefined;
  return {
    name,
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    type: text(raw.type) ?? "simple",
    ...(text(params.measure?.name)
      ? { measure: text(params.measure?.name) }
      : {}),
    ...(text(params.numerator?.name)
      ? { numerator: text(params.numerator?.name) }
      : {}),
    ...(text(params.denominator?.name)
      ? { denominator: text(params.denominator?.name) }
      : {}),
    ...(text(params.expr) ? { expr: text(params.expr) } : {}),
    ...(inputMetrics.length > 0 ? { inputMetrics } : {}),
    ...(window ? { window } : {}),
    ...(text(params.grain_to_date)
      ? { grainToDate: text(params.grain_to_date) }
      : {}),
    filtered:
      hasFilter(raw.filter) ||
      hasFilter(params.measure?.filter) ||
      hasFilter(params.numerator?.filter) ||
      hasFilter(params.denominator?.filter),
  };
}

/**
 * Build the catalog. Private metrics (`is_private`: building blocks the
 * project hides from queries) are left out; MetricFlow refuses them anyway.
 */
export function buildSemanticCatalog(
  manifest: RawSemanticManifest,
): SemanticCatalog {
  const metrics = (manifest.metrics ?? [])
    .filter(raw => raw?.type_params?.is_private !== true)
    .map(catalogMetric)
    .filter((metric): metric is CatalogMetric => metric !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const config = manifest.project_configuration ?? {};
  return {
    metrics,
    semanticModels: (manifest.semantic_models ?? []).flatMap(model => {
      const name = text(model?.name);
      if (!name) return [];
      return [
        {
          name,
          ...(text(model.description)
            ? { description: text(model.description) }
            : {}),
          ...(text(model.node_relation?.relation_name)
            ? { relation: text(model.node_relation?.relation_name) }
            : {}),
          ...(text(model.node_relation?.database)
            ? { database: text(model.node_relation?.database) }
            : {}),
        },
      ];
    }),
    savedQueries: (manifest.saved_queries ?? [])
      .map(query => text(query?.name))
      .filter((name): name is string => Boolean(name)),
    hasTimeSpine:
      (config.time_spines?.length ?? 0) > 0 ||
      (config.time_spine_table_configurations?.length ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** "Monthly Recurring Revenue" and "monthly_recurring_revenue" are one key. */
export function metricKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Metrics whose name, label or description contains every word of `query`. */
export function searchMetrics(
  catalog: SemanticCatalog,
  query: string | undefined,
): CatalogMetric[] {
  const words = metricKey(query ?? "")
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return catalog.metrics;
  return catalog.metrics.filter(metric => {
    const haystack = metricKey(
      `${metric.name} ${metric.label ?? ""} ${metric.description ?? ""}`,
    );
    return words.every(word => haystack.includes(word));
  });
}

/**
 * The metric a phrase names: its name or its label, compared without case,
 * spaces or underscores. Exact only — a near miss is not a definition.
 */
export function findMetricByPhrase(
  catalog: SemanticCatalog,
  phrases: readonly string[],
): CatalogMetric | undefined {
  const keys = new Set(phrases.map(metricKey).filter(Boolean));
  if (keys.size === 0) return undefined;
  return catalog.metrics.find(
    metric =>
      keys.has(metricKey(metric.name)) ||
      (metric.label !== undefined && keys.has(metricKey(metric.label))),
  );
}

/** Names of `wanted` the catalog does not define, in the order given. */
export function unknownMetrics(
  catalog: SemanticCatalog,
  wanted: readonly string[],
): string[] {
  const known = new Set(catalog.metrics.map(metric => metric.name));
  return wanted.filter(name => !known.has(name));
}
