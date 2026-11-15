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

interface RawWindow {
  count?: number;
  granularity?: string;
}

interface RawMetricInput {
  name?: string;
  filter?: unknown;
  alias?: string | null;
  offset_window?: RawWindow | null;
  offset_to_grain?: string | null;
  join_to_timespine?: boolean | null;
  fill_nulls_with?: number | null;
}

interface RawConversionParams {
  base_measure?: RawMetricInput | null;
  conversion_measure?: RawMetricInput | null;
  base_metric?: RawMetricInput | null;
  conversion_metric?: RawMetricInput | null;
  entity?: string | null;
  calculation?: string | null;
  window?: RawWindow | null;
  constant_properties?: Array<{
    base_property?: string;
    conversion_property?: string;
  }> | null;
}

interface RawCumulativeParams {
  window?: RawWindow | null;
  grain_to_date?: string | null;
  period_agg?: string | null;
}

interface RawSavedQuery {
  name?: string;
  description?: string | null;
  label?: string | null;
  query_params?: {
    metrics?: string[] | null;
    group_by?: string[] | null;
    where?: unknown;
    order_by?: string[] | null;
    limit?: number | null;
  } | null;
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
    window?: RawWindow | null;
    grain_to_date?: string | null;
    metrics?: RawMetricInput[] | null;
    conversion_type_params?: RawConversionParams | null;
    cumulative_type_params?: RawCumulativeParams | null;
    join_to_timespine?: boolean | null;
    fill_nulls_with?: number | null;
    is_private?: boolean | null;
  } | null;
  /** The grain the metric is reported at when a query names none. */
  time_granularity?: string | null;
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
  saved_queries?: RawSavedQuery[];
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

/** A metric another metric reads, with what the definition changes on it. */
export interface CatalogMetricInput {
  name: string;
  /** What the input stands for in a ratio; unset for a derived metric. */
  role?: "numerator" | "denominator";
  /** The name the expression calls it by. */
  alias?: string;
  /** The input shifted back in time ("1 month"): period over period. */
  offsetWindow?: string;
  /** The input taken at the start of the grain ("month"): since period start. */
  offsetToGrain?: string;
  /** Filters on this input alone, as written. */
  filters?: string[];
}

/** A conversion metric: base events followed by a conversion event. */
export interface CatalogConversion {
  baseMeasure?: string;
  conversionMeasure?: string;
  baseMetric?: string;
  conversionMetric?: string;
  /** The entity both events are joined on. */
  entity?: string;
  /** `conversion_rate` or `conversions`. */
  calculation?: string;
  /** How long after the base event a conversion counts ("7 day"). */
  window?: string;
  /** Properties that must be equal on both events. */
  constantProperties?: Array<{ base: string; conversion: string }>;
}

/** A query the project saved by name: metrics, group-bys and filters. */
export interface CatalogSavedQuery {
  name: string;
  label?: string;
  description?: string;
  metrics: string[];
  groupBy: string[];
  where: string[];
  orderBy?: string[];
  limit?: number;
}

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
  /** A cumulative metric's value within a coarser period: first, last, average. */
  periodAgg?: string;
  /** The inputs of a ratio or derived metric, with offsets, aliases, filters. */
  inputs?: CatalogMetricInput[];
  /** A conversion metric's definition. */
  conversion?: CatalogConversion;
  /** The value reported for periods without data, instead of NULL. */
  fillNullsWith?: number;
  /** True when periods without data are filled from the time spine. */
  joinToTimespine?: true;
  /** The grain the metric is reported at when a query names none. */
  timeGranularity?: string;
  /** The definition's own filters, as written. */
  filters?: string[];
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
  savedQueries: CatalogSavedQuery[];
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

/** The SQL templates of a filter ("{{ Dimension('a__b') }} = 'x'"). */
function filterTexts(filter: unknown): string[] {
  if (!filter || typeof filter !== "object") return [];
  const filters = (filter as { where_filters?: unknown[] }).where_filters;
  if (!Array.isArray(filters)) return [];
  return filters.flatMap(entry => {
    const template = text(
      (entry as { where_sql_template?: unknown } | null)?.where_sql_template,
    );
    return template ? [template] : [];
  });
}

const windowText = (window: RawWindow | null | undefined) =>
  window?.count && window.granularity
    ? `${window.count} ${window.granularity}`
    : undefined;

function catalogInput(
  raw: RawMetricInput | null | undefined,
  role?: CatalogMetricInput["role"],
): CatalogMetricInput | null {
  const name = text(raw?.name);
  if (!raw || !name) return null;
  const filters = filterTexts(raw.filter);
  return {
    name,
    ...(role ? { role } : {}),
    ...(text(raw.alias) ? { alias: text(raw.alias) } : {}),
    ...(windowText(raw.offset_window)
      ? { offsetWindow: windowText(raw.offset_window) }
      : {}),
    ...(text(raw.offset_to_grain)
      ? { offsetToGrain: text(raw.offset_to_grain) }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
  };
}

function catalogConversion(
  raw: RawConversionParams | null | undefined,
): CatalogConversion | undefined {
  if (!raw) return undefined;
  const constant = (raw.constant_properties ?? []).flatMap(property => {
    const base = text(property?.base_property);
    const conversion = text(property?.conversion_property);
    return base && conversion ? [{ base, conversion }] : [];
  });
  const named = (key: string, value: string | undefined) =>
    value ? { [key]: value } : {};
  return {
    ...named("baseMeasure", text(raw.base_measure?.name)),
    ...named("conversionMeasure", text(raw.conversion_measure?.name)),
    ...named("baseMetric", text(raw.base_metric?.name)),
    ...named("conversionMetric", text(raw.conversion_metric?.name)),
    ...named("entity", text(raw.entity)),
    ...named("calculation", text(raw.calculation)),
    ...named("window", windowText(raw.window)),
    ...(constant.length > 0 ? { constantProperties: constant } : {}),
  };
}

function catalogMetric(raw: RawMetric): CatalogMetric | null {
  const name = text(raw.name);
  if (!name) return null;
  const params = raw.type_params ?? {};
  const cumulative = params.cumulative_type_params ?? {};
  const inputMetrics = (params.metrics ?? [])
    .map(input => text(input?.name))
    .filter((input): input is string => Boolean(input));
  // dbt 1.9+ writes a cumulative metric's window under
  // cumulative_type_params; the top-level fields are the older spelling.
  const window = windowText(cumulative.window) ?? windowText(params.window);
  const grainToDate =
    text(cumulative.grain_to_date) ?? text(params.grain_to_date);
  const type = text(raw.type) ?? "simple";
  const inputs = [
    catalogInput(params.numerator, "numerator"),
    catalogInput(params.denominator, "denominator"),
    ...(params.metrics ?? []).map(input => catalogInput(input)),
  ].filter(
    (input): input is CatalogMetricInput =>
      // Worth returning only when it says more than the name does.
      input !== null &&
      Boolean(
        input.alias ||
        input.offsetWindow ||
        input.offsetToGrain ||
        input.filters,
      ),
  );
  const conversion = catalogConversion(params.conversion_type_params);
  const fillNullsWith =
    params.fill_nulls_with ?? params.measure?.fill_nulls_with ?? undefined;
  const joinToTimespine =
    params.join_to_timespine === true ||
    params.measure?.join_to_timespine === true;
  const filters = [
    ...filterTexts(raw.filter),
    ...filterTexts(params.measure?.filter),
  ];
  return {
    name,
    ...(text(raw.label) ? { label: text(raw.label) } : {}),
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    type,
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
    ...(grainToDate ? { grainToDate } : {}),
    ...(type === "cumulative" && text(cumulative.period_agg)
      ? { periodAgg: text(cumulative.period_agg) }
      : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(conversion && Object.keys(conversion).length > 0 ? { conversion } : {}),
    ...(typeof fillNullsWith === "number" ? { fillNullsWith } : {}),
    ...(joinToTimespine ? { joinToTimespine: true as const } : {}),
    ...(text(raw.time_granularity)
      ? { timeGranularity: text(raw.time_granularity) }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
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
    savedQueries: (manifest.saved_queries ?? []).flatMap(query => {
      const name = text(query?.name);
      if (!name) return [];
      const params = query.query_params ?? {};
      const strings = (values: unknown) =>
        Array.isArray(values)
          ? values.filter((v): v is string => typeof v === "string")
          : [];
      return [
        {
          name,
          ...(text(query.label) ? { label: text(query.label) } : {}),
          ...(text(query.description)
            ? { description: text(query.description) }
            : {}),
          metrics: strings(params.metrics),
          groupBy: strings(params.group_by),
          where: filterTexts(params.where),
          ...(strings(params.order_by).length > 0
            ? { orderBy: strings(params.order_by) }
            : {}),
          ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        },
      ];
    }),
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
