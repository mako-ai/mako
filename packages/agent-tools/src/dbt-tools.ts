/**
 * Client-Side dbt Tools
 *
 * File-editing tools for the dbt IDE ("dbt Cloud replica"). Like the app
 * tools these have no `execute` function, so the AI SDK routes them to the
 * browser via `onToolCall`, where `executeDbtAgentTool` applies them to the
 * dbtStore (the same writeFile path the editor uses) and persists them.
 *
 * Server-side verification tools (dbt_parse / dbt_compile_model /
 * dbt_run_model / dbt_run_job) live in api/src/agent-lib/tools/dbt-tools.ts
 * because they invoke the dbt runner.
 */

import { tool } from "ai";
import { z } from "zod";

const projectIdField = z
  .string()
  .describe("dbt project ID (from read_dbt_project_tree)");

const dbtPathField = z
  .string()
  .describe(
    "POSIX file path relative to the project root, e.g. models/staging/stg_orders.sql",
  );

const readTreeSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      "dbt project ID. Omit to list all projects in the workspace with their environments.",
    ),
});

const readFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
});

const createFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
  contents: z.string().describe("Full UTF-8 file contents"),
});

const modifyFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
  contents: z
    .string()
    .describe(
      "Full replacement contents for the file. Write the complete file, not a diff.",
    ),
});

const deleteFileSchema = z.object({
  projectId: projectIdField,
  path: dbtPathField,
});

export const clientDbtTools = {
  read_dbt_project_tree: tool({
    description:
      "List dbt projects in the workspace, or the file tree + jobs of one " +
      "project when projectId is given. Call this FIRST to get project IDs " +
      "and file paths before using any other dbt tool.",
    inputSchema: readTreeSchema,
  }),
  read_dbt_file: tool({
    description:
      "Read the full contents of a single file in a dbt project " +
      "(models, schema.yml, dbt_project.yml, seeds, macros...).",
    inputSchema: readFileSchema,
  }),
  create_dbt_file: tool({
    description:
      "Create a new file in a dbt project (e.g. a staging model + its " +
      "schema.yml entry). Fails if the file already exists — use " +
      "modify_dbt_file to change existing files. After writing models, " +
      "verify with dbt_parse and dbt_compile_model.",
    inputSchema: createFileSchema,
  }),
  modify_dbt_file: tool({
    description:
      "Overwrite an existing dbt project file with full contents. The open " +
      "editor tab updates live; every save snapshots a version for undo. " +
      "After editing, verify with dbt_parse / dbt_compile_model.",
    inputSchema: modifyFileSchema,
  }),
  delete_dbt_file: tool({
    description: "Delete a file from a dbt project.",
    inputSchema: deleteFileSchema,
  }),
};

export type DbtCreateFileInput = z.infer<typeof createFileSchema>;
export type DbtModifyFileInput = z.infer<typeof modifyFileSchema>;
