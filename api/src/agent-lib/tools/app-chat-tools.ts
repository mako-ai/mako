/**
 * Tools for "chat with app": the agent a published app's viewers talk to.
 *
 * Deliberately closed: every tool is read-only and scoped to ONE app at its
 * published commit. The data tools read the app's own binding parquet (what
 * the viewer's browser already downloads); the source tool reads the app's
 * files at that commit. Nothing reaches a warehouse connection, another app,
 * or anything else in the workspace.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { IAppProject } from "../../database/workspace-schema";
import {
  listPublishedFiles,
  loadAppChatData,
  queryableTables,
  readPublishedFile,
  type AppChatData,
} from "../../apps/app-chat.service";
import { describeAppData, queryAppData } from "../../apps/app-chat-query";
import type { AgentToolExecutionContext } from "../../agents/types";
import { capText, READ_MAX_CHARS } from "./shared/output-cap";
import {
  formatRowsForModel,
  QUERY_RESULT_DEFAULT_ROWS,
  QUERY_RESULT_MAX_ROWS,
} from "./shared/query-result-format";

const QUERY_TEXT_MAX_CHARS = 4_000;
const SOURCE_LIST_LIMIT = 300;

export const APP_CHAT_TOOL_NAMES = [
  "describe_app_data",
  "query_app_data",
  "read_app_source",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppChatTools(input: {
  project: IAppProject;
  toolExecutionContext?: AgentToolExecutionContext;
}): ToolSet {
  const { project, toolExecutionContext } = input;

  // One load per turn: binding files and cached parquet paths do not change
  // within a turn, and every tool needs them.
  let dataPromise: Promise<AppChatData> | null = null;
  const data = () => {
    dataPromise ??= loadAppChatData(project).catch(error => {
      dataPromise = null;
      throw error;
    });
    return dataPromise;
  };

  return {
    describe_app_data: tool({
      description:
        "Describe the app's data: each binding (a table you can query) with the SQL that produces it, its columns and types, row count and a few sample rows. Call this first. Pass `binding` to describe just one.",
      inputSchema: z.object({
        binding: z
          .string()
          .optional()
          .describe("Describe only this binding (table) name"),
      }),
      execute: async ({ binding }) => {
        try {
          const loaded = await data();
          const selected = binding
            ? loaded.bindings.filter(b => b.name === binding)
            : loaded.bindings;
          if (binding && selected.length === 0) {
            return {
              success: false,
              error: `No binding named "${binding}". Bindings: ${loaded.bindings.map(b => b.name).join(", ") || "(none)"}`,
            };
          }
          const tables = queryableTables({ ...loaded, bindings: selected });
          const summaries = await describeAppData(tables, 3, {
            mode: loaded.parquetMode,
            gcsAuth: loaded.gcsAuth,
          });
          return {
            success: true,
            bindings: selected.map(b => {
              const summary = summaries.find(s => s.name === b.name);
              return {
                name: b.name,
                query: capText(b.code, {
                  maxChars: QUERY_TEXT_MAX_CHARS,
                  headChars: QUERY_TEXT_MAX_CHARS - 500,
                }).text,
                ...(b.file && summary && !summary.error
                  ? {
                      rowCount: summary.rowCount,
                      columns: summary.columns,
                      sample: formatRowsForModel(summary.sampleRows, {
                        fields: summary.columns,
                        maxRows: 3,
                      }).table,
                    }
                  : {
                      unavailable:
                        b.unavailable ?? summary?.error ?? "data unavailable",
                    }),
              };
            }),
            ...(loaded.skipped.length > 0 && !binding
              ? { skipped: loaded.skipped }
              : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    query_app_data: tool({
      description:
        'Run one read-only DuckDB SQL query over the app\'s data. Each binding is a table named after it (double-quote names: "monthly-revenue"). Aggregate in SQL rather than reading raw rows. Returns at most `max_rows` rows.',
      inputSchema: z.object({
        sql: z
          .string()
          .min(1)
          .describe("DuckDB SQL (SELECT / WITH / DESCRIBE / SUMMARIZE)"),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(QUERY_RESULT_MAX_ROWS)
          .optional()
          .describe(`Rows to return (default ${QUERY_RESULT_DEFAULT_ROWS})`),
      }),
      execute: async ({ sql, max_rows }) => {
        try {
          const loaded = await data();
          const tables = queryableTables(loaded);
          if (tables.length === 0) {
            return {
              success: false,
              error:
                "This app has no queryable data (no materialized bindings).",
            };
          }
          const maxRows = max_rows ?? QUERY_RESULT_DEFAULT_ROWS;
          const result = await queryAppData(tables, sql, {
            maxRows,
            signal: toolExecutionContext?.signal,
            mode: loaded.parquetMode,
            gcsAuth: loaded.gcsAuth,
          });
          const formatted = formatRowsForModel(result.rows, {
            fields: result.columns,
            maxRows,
            moreHint: "Aggregate or filter in SQL to see what matters.",
          });
          return {
            success: true,
            ...formatted,
            ...(result.truncated
              ? {
                  truncated: true as const,
                  note: [
                    formatted.note,
                    `The query returned more than ${maxRows} rows.`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                }
              : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    read_app_source: tool({
      description:
        "Read the app's source code at its published version, to explain how something on screen is computed. Without `path`, lists the files; with `path` (app-relative, e.g. src/App.tsx), returns that file.",
      inputSchema: z.object({
        path: z.string().optional().describe("App-relative file path"),
      }),
      execute: async ({ path }) => {
        try {
          const sha = project.publishedSha;
          if (!sha) {
            return { success: false, error: "This app is not published" };
          }
          if (!path) {
            const files = await listPublishedFiles(
              project,
              sha,
              SOURCE_LIST_LIMIT,
            );
            return {
              success: true,
              files: files.slice(0, SOURCE_LIST_LIMIT),
              ...(files.length > SOURCE_LIST_LIMIT ? { truncated: true } : {}),
            };
          }
          const file = await readPublishedFile(project, sha, path);
          if (file.isBinary) {
            return { success: false, error: `${path} is a binary file` };
          }
          const capped = capText(file.contents, {
            maxChars: READ_MAX_CHARS,
            headChars: READ_MAX_CHARS - 5_000,
          });
          return {
            success: true,
            path,
            contents: capped.text,
            ...(capped.truncated ? { truncated: true } : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}
