/**
 * Client-Side React App Tools
 *
 * Agentic file-editing tools for the React Apps feature (Lovable / v0 style).
 * Like the dashboard tools, these have no `execute` function, so the AI SDK
 * routes them to the browser via `onToolCall`, where `executeAppAgentTool`
 * applies them to the open app's virtual filesystem and refreshes the preview.
 *
 * The edit protocol is deliberately simple (whole-file writes, dependency
 * add/remove, data-binding create), mirroring dyad's `<dyad-write>` /
 * `<dyad-add-dependency>` approach.
 */

import { tool } from "ai";
import { z } from "zod";

const appIdField = z.string().describe("App ID (from list_open_apps)");

const writeFileSchema = z.object({
  appId: appIdField,
  path: z
    .string()
    .describe("POSIX file path relative to project root, e.g. src/App.tsx"),
  contents: z.string().describe("Full UTF-8 file contents to write"),
});

const deleteFileSchema = z.object({
  appId: appIdField,
  path: z.string().describe("File path to delete"),
});

const renameFileSchema = z.object({
  appId: appIdField,
  from: z.string().describe("Existing file path"),
  to: z.string().describe("New file path"),
});

const readFileSchema = z.object({
  appId: appIdField,
  path: z.string().describe("File path to read"),
});

const addDependencySchema = z.object({
  appId: appIdField,
  name: z.string().describe("npm package name, e.g. d3"),
  version: z
    .string()
    .optional()
    .describe("Semver range. Defaults to 'latest' when omitted."),
});

const removeDependencySchema = z.object({
  appId: appIdField,
  name: z.string().describe("npm package name to remove"),
});

const createDataBindingSchema = z.object({
  appId: appIdField,
  name: z
    .string()
    .describe("Binding name referenced from app code via useQuery(name)"),
  connectionId: z
    .string()
    .describe("Workspace connection ID to run the query against"),
  language: z.enum(["sql", "javascript", "mongodb"]).default("sql"),
  code: z.string().describe("Query text/code to execute server-side"),
  databaseId: z.string().optional(),
  databaseName: z.string().optional(),
  materialization: z
    .enum(["live", "parquet"])
    .default("live")
    .describe(
      "'live' runs the query server-side on every read. 'parquet' materializes " +
        "the query to a Parquet artifact loaded into DuckDB-WASM in the browser, " +
        "enabling fast client-side analytical SQL via useDuckDB(sql). " +
        "Use 'parquet' for analytics/aggregation over larger result sets; after " +
        "creating a parquet binding, call materialize_binding to build it.",
    ),
});

const materializeBindingSchema = z.object({
  appId: appIdField,
  name: z.string().describe("Name of the parquet binding to (re)materialize"),
  waitSeconds: z
    .number()
    .min(0)
    .max(600)
    .optional()
    .describe(
      "How long to wait for the background build before returning (default " +
        "120, max 600). Use 0 to check the current status without waiting. " +
        "If the build is still running when the wait elapses, the tool " +
        "returns status 'building' — call again to keep waiting.",
    ),
});

const createAppSchema = z.object({
  title: z.string().describe("App title"),
  description: z.string().optional().describe("Brief description"),
});

export const clientAppTools = {
  list_open_apps: tool({
    description:
      "List all open React App tabs. Returns each app's id, title, file count, " +
      "dependency list, data bindings, and isActive flag. " +
      "Call this FIRST to get app IDs before using any other app tool.",
    inputSchema: z.object({}),
  }),
  open_app: tool({
    description:
      "Open a saved app by its ID into a tab and load its files. " +
      "Returns the appId to use with other tools.",
    inputSchema: z.object({ appId: z.string().describe("App ID to open") }),
  }),
  create_app: tool({
    description:
      "Create a new React app from the default scaffold (React + TypeScript). " +
      "Opens it in a tab and returns the new appId. After creating, use " +
      "app_write_file to build features and app_add_dependency to add libraries.",
    inputSchema: createAppSchema,
  }),
  get_app_state: tool({
    description:
      "Get the app definition: file list (paths), dependencies, data bindings, " +
      "entrypoint, runtime, and the latest preview build/runtime errors. " +
      "Use this to understand the project and to read build errors before fixing them.",
    inputSchema: z.object({ appId: appIdField }),
  }),
  app_read_file: tool({
    description: "Read the full contents of a single file in the app.",
    inputSchema: readFileSchema,
  }),
  app_write_file: tool({
    description:
      "Create or overwrite a file with full contents. This is the primary " +
      "editing tool — write the complete file, not a diff. Writing the " +
      "entrypoint or any imported file refreshes the live preview.",
    inputSchema: writeFileSchema,
  }),
  app_delete_file: tool({
    description: "Delete a file from the app.",
    inputSchema: deleteFileSchema,
  }),
  app_rename_file: tool({
    description: "Rename/move a file within the app.",
    inputSchema: renameFileSchema,
  }),
  app_add_dependency: tool({
    description:
      "Add an npm dependency to the app (e.g. d3, framer-motion, recharts). " +
      "The dependency becomes importable from app code on the next preview build.",
    inputSchema: addDependencySchema,
  }),
  app_remove_dependency: tool({
    description: "Remove an npm dependency from the app.",
    inputSchema: removeDependencySchema,
  }),
  app_create_data_binding: tool({
    description:
      "Create a named data binding that the app can read via useQuery(name) " +
      "from '@mako/app-sdk'. The query runs server-side, scoped to the " +
      "workspace — the app never sees credentials. Set materialization to " +
      "'parquet' for DuckDB-WASM-backed analytics (then call materialize_binding). " +
      "Use the SQL connections/tools to inspect schema and validate the query first.",
    inputSchema: createDataBindingSchema,
  }),
  materialize_binding: tool({
    description:
      "Build (or rebuild) the Parquet artifact for a 'parquet' data binding and " +
      "load it into the app's DuckDB-WASM instance. Run this after creating or " +
      "editing a parquet binding so useQuery/useDuckDB return fresh data. " +
      "The build runs server-side in the background: the tool waits up to " +
      "waitSeconds (default 120) and returns status 'building' if it is still " +
      "running — that is not an error; the app picks up the data automatically " +
      "when ready. To block until completion, call this tool again (it resumes " +
      "waiting on the in-flight build); use waitSeconds: 0 for an instant " +
      "status check.",
    inputSchema: materializeBindingSchema,
  }),
  run_app: tool({
    description:
      "Rebuild and reload the app preview. Use after a batch of edits, or to " +
      "recover from a stuck preview. Returns any build/runtime errors.",
    inputSchema: z.object({ appId: appIdField }),
  }),
};

export type AppWriteFileInput = z.infer<typeof writeFileSchema>;
export type AppCreateDataBindingInput = z.infer<typeof createDataBindingSchema>;
