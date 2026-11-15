/**
 * dbt tool schemas (shared source of truth for the dbt IDE tool cards).
 *
 * ALL dbt agent tools now execute SERVER-SIDE against the authoritative
 * DbtProject/DbtFile/DbtJob documents (issue #475 pattern) — both the file
 * mutations (create/modify/delete) AND the reads (read_dbt_project_tree /
 * read_dbt_file). Reads moved server-side because a client-executed read leaves
 * a tool call pending in the browser; if the tab is slow/backgrounded/detached
 * the SSE turn tears down with "stream disconnected before tool completed".
 * Reading the docs on the server keeps the turn entirely server-driven.
 *
 * Verification tools (dbt_parse / dbt_compile_model / dbt_run_model /
 * dbt_run_job) also live server-side because they invoke the dbt runner.
 *
 * `clientDbtTools` is therefore intentionally empty — no dbt tool is browser
 * executed anymore.
 */

import { z } from "zod";

const projectIdField = z
  .string()
  .describe("dbt project ID (from read_dbt_project_tree)");

const dbtPathField = z
  .string()
  .describe(
    "POSIX file path relative to the project root, e.g. models/staging/stg_orders.sql",
  );

export const readDbtTreeSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      "dbt project ID. Omit to list all projects in the workspace with their environments.",
    ),
});

export const readDbtFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
});

// All dbt tools execute SERVER-SIDE (see api/src/agent-lib/tools/dbt-tools.ts).
// Schemas are exported here so the server tools and the dbt IDE tool cards share
// a single source of truth.
export const createDbtFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
  contents: z.string().describe("Full UTF-8 file contents"),
});

export const modifyDbtFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
  contents: z
    .string()
    .describe(
      "Full replacement contents for the file. Write the complete file, not a diff.",
    ),
});

export const editDbtFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
  oldString: z
    .string()
    .describe(
      "Exact text to replace. Must match the current file contents exactly " +
        "(including whitespace/indentation) and exactly once — include a few " +
        "surrounding lines to make the match unique. Must not be empty.",
    ),
  newString: z
    .string()
    .describe(
      "Replacement text. Use \"\" to delete the matched text. To insert, " +
        "anchor on adjacent content and include it in both strings.",
    ),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of oldString (for renames). Defaults to " +
        "false, which requires the match to be unique.",
    ),
});

export const deleteDbtFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
});

// No dbt tools are browser-executed anymore — reads and writes alike run on the
// server. Kept as an (empty) export so the agent wiring/types stay stable.
export const clientDbtTools = {};

export type DbtCreateFileInput = z.infer<typeof createDbtFileSchema>;
export type DbtModifyFileInput = z.infer<typeof modifyDbtFileSchema>;
export type DbtEditFileInput = z.infer<typeof editDbtFileSchema>;

// Ontology lookups (api/src/agent-lib/tools/dbt-ontology-tools.ts): read the
// last production manifest and the workspace's term registry, never a file.
const ontologyProjectIdField = z
  .string()
  .optional()
  .describe(
    "dbt project ID. Omit to cover every dbt project in the workspace (usually one).",
  );

export const findModelsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'What the data is about: a business term ("monthly recurring revenue"), a column ("account_id") or part of a model name ("renewals").',
    ),
  layer: z
    .string()
    .max(64)
    .optional()
    .describe(
      'Keep one layer: "staging", "intermediate", "marts", "source", "seed", or a folder under models/.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(25)
    .optional()
    .describe("Maximum results (default 10)."),
  projectId: ontologyProjectIdField,
});

export const describeModelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'A model or seed name ("fct_orders"), a source as "<source>.<table>", or a warehouse relation ("dataset.table").',
    ),
  projectId: ontologyProjectIdField,
});

export const lookupTermSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'A business term or entity, by name, label or synonym: "MRR", "paying customers", "account".',
    ),
});

export const modelReadersSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'A dbt model, seed or source name, or a raw warehouse table as "dataset.table" or "project.dataset.table".',
    ),
  projectId: ontologyProjectIdField,
});

export const findJoinPathSchema = z.object({
  from: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'Where the join starts: an entity name or synonym ("subscription", "customer"), a dbt model ("dim_account") or a raw table ("crm_public.users").',
    ),
  to: z
    .string()
    .min(1)
    .max(300)
    .describe("Where the join ends: same forms as `from`."),
  maxHops: z
    .number()
    .int()
    .positive()
    .max(6)
    .optional()
    .describe("Longest path to search, in joins (default 4, at most 6)."),
});

// Semantic layer (api/src/agent-lib/tools/dbt-metric-tools.ts): the metrics a
// dbt project defines for MetricFlow, read from the semantic manifest of the
// last production build.
const metricNamesField = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(10)
  .describe(
    'Metric names from list_metrics: ["revenue", "average_order_value"].',
  );

const metricEnvironmentField = z
  .string()
  .max(100)
  .optional()
  .describe(
    'dbt environment to read instead of production, e.g. a personal dev one ("joan"): tries a metric from that environment\'s latest run before it is merged.',
  );

/**
 * A metric_time bound: a date or a naive datetime. MetricFlow compares it
 * with naive datetimes, so an offset ("+02:00", "Z") cannot be honoured.
 */
const METRIC_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?$/;

const metricTimeField = (name: string, description: string) =>
  z
    .string()
    .max(40)
    .regex(
      METRIC_TIME_PATTERN,
      `${name} must be a date ("2026-01-01") or a datetime without a timezone ("2026-01-01T00:00:00"). Drop the offset: metric_time has no timezone.`,
    )
    .optional()
    .describe(description);

const metricQueryFields = {
  metrics: metricNamesField,
  groupBy: z
    .array(z.string().min(1).max(300))
    .max(20)
    .optional()
    .describe(
      'Group-bys as list_metrics({ metrics }) names them: "metric_time__month" (day, week, month, quarter, year), "customer__region". Omit for one total row.',
    ),
  where: z
    .array(z.string().min(1).max(2000))
    .max(10)
    .optional()
    .describe(
      "Filters, ANDed: SQL conditions naming dimensions through templates: \"{{ Dimension('customer__region') }} = 'EU'\", \"{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'\", \"{{ Entity('customer') }} = 42\".",
    ),
  orderBy: z
    .array(z.string().min(1).max(300))
    .max(10)
    .optional()
    .describe(
      'Names to order by; "-" prefix for descending: ["-revenue"].',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe("Row limit written into the SQL."),
  startTime: metricTimeField(
    "startTime",
    'Start of the metric_time range, inclusive: "2026-01-01". Widened to whole periods of the grain grouped by (a week starts on Monday). A date or a datetime without a timezone.',
  ),
  endTime: metricTimeField(
    "endTime",
    'End of the metric_time range, inclusive: "2026-03-31". A date or a datetime without a timezone; not before startTime.',
  ),
  projectId: z
    .string()
    .optional()
    .describe(
      "dbt project ID. Only needed when several projects define the metric.",
    ),
  environment: metricEnvironmentField,
};

export const listMetricsSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Keep metrics whose name, label or description contains this: "revenue". Omit to list all.',
    ),
  metrics: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe(
      "Metric names to describe in full, with the group-bys they share.",
    ),
  projectId: ontologyProjectIdField,
  environment: metricEnvironmentField,
});

export const compileMetricSchema = z.object(metricQueryFields);

export const queryMetricSchema = z.object({
  ...metricQueryFields,
  maxRows: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Rows to show in the result table (default 50)."),
});

export type ListMetricsInput = z.infer<typeof listMetricsSchema>;
export type CompileMetricInput = z.infer<typeof compileMetricSchema>;
export type QueryMetricInput = z.infer<typeof queryMetricSchema>;
export type FindJoinPathInput = z.infer<typeof findJoinPathSchema>;
export type FindModelsInput = z.infer<typeof findModelsSchema>;
export type DescribeModelInput = z.infer<typeof describeModelSchema>;
export type LookupTermInput = z.infer<typeof lookupTermSchema>;
export type ModelReadersInput = z.infer<typeof modelReadersSchema>;
