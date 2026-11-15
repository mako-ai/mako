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
    'Metric names exactly as list_metrics returns them: ["revenue"], ["revenue", "average_order_value"].',
  );

const metricQueryFields = {
  metrics: metricNamesField,
  groupBy: z
    .array(z.string().min(1).max(300))
    .max(20)
    .optional()
    .describe(
      'Dimensions and entities to group by, as list_metrics({ metrics }) names them: "metric_time__month" (any grain: day, week, month, quarter, year), "customer__region". Omit for one total row.',
    ),
  where: z
    .array(z.string().min(1).max(2000))
    .max(10)
    .optional()
    .describe(
      "Filters, ANDed. Each is a SQL condition that names dimensions through MetricFlow templates: \"{{ Dimension('customer__region') }} = 'EU'\", \"{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'\", \"{{ Entity('customer') }} = 42\".",
    ),
  orderBy: z
    .array(z.string().min(1).max(300))
    .max(10)
    .optional()
    .describe(
      'Metric or group-by names to order by; prefix "-" for descending: ["-metric_time__month"].',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe("Row limit written into the SQL."),
  startTime: z
    .string()
    .max(40)
    .optional()
    .describe(
      'Start of the metric_time range, inclusive, ISO 8601: "2026-01-01". MetricFlow widens the range to whole periods of the grain grouped by (a week grain starts on its Monday).',
    ),
  endTime: z
    .string()
    .max(40)
    .optional()
    .describe('End of the metric_time range, inclusive, ISO 8601: "2026-03-31".'),
  projectId: z
    .string()
    .optional()
    .describe(
      "dbt project ID. Omit when one project defines the metrics (the usual case).",
    ),
};

export const listMetricsSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Keep metrics whose name, label or description contains this text: "revenue", "churn". Omit to list them all.',
    ),
  metrics: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe(
      "Metric names to describe in full: definition, inputs, and the dimensions and entities they can ALL be grouped by together.",
    ),
  projectId: ontologyProjectIdField,
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
