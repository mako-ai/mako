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

export type FindModelsInput = z.infer<typeof findModelsSchema>;
export type DescribeModelInput = z.infer<typeof describeModelSchema>;
export type LookupTermInput = z.infer<typeof lookupTermSchema>;
export type ModelReadersInput = z.infer<typeof modelReadersSchema>;
