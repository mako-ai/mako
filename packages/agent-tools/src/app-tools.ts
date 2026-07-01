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

// NOTE: the mutation tools below (write/delete/rename file, add/remove
// dependency, create/delete data binding) execute SERVER-SIDE (mirroring the
// console #475 pattern) — see api/src/agent-lib/tools/server-app-tools.ts. Their
// schemas are exported here so the server tools and the app's tool cards share
// a single source of truth. They are intentionally NOT in `clientAppTools`.
export const writeFileSchema = z.object({
  appId: appIdField,
  path: z
    .string()
    .describe("POSIX file path relative to project root, e.g. src/App.tsx"),
  contents: z.string().describe("Full UTF-8 file contents to write"),
});

export const deleteFileSchema = z.object({
  appId: appIdField,
  path: z.string().describe("File path to delete"),
});

export const renameFileSchema = z.object({
  appId: appIdField,
  from: z.string().describe("Existing file path"),
  to: z.string().describe("New file path"),
});

const readFileSchema = z.object({
  appId: appIdField,
  path: z.string().describe("File path to read"),
});

export const addDependencySchema = z.object({
  appId: appIdField,
  name: z.string().describe("npm package name, e.g. d3"),
  version: z
    .string()
    .optional()
    .describe("Semver range. Defaults to 'latest' when omitted."),
});

export const removeDependencySchema = z.object({
  appId: appIdField,
  name: z.string().describe("npm package name to remove"),
});

/**
 * Per-binding materialization schedule. Mirrors
 * `AppBindingMaterializationScheduleSchema` in `@mako/schemas`; kept as a local
 * zod object so the agent-tools package stays dependency-light.
 */
export const bindingMaterializationScheduleSchema = z.object({
  enabled: z.boolean().describe("Whether scheduled auto-refresh is enabled"),
  cron: z
    .string()
    .nullable()
    .describe(
      "5-field cron expression (e.g. '0 * * * *' = hourly, '0 0 * * *' = " +
        "daily). Required when enabled; pass null when disabled.",
    ),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for the cron (defaults to UTC)"),
  dataFreshnessTtlMs: z
    .number()
    .nullable()
    .optional()
    .describe("Optional freshness window in ms used for staleness badges"),
});

export const createDataBindingSchema = z.object({
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
  materializationSchedule: bindingMaterializationScheduleSchema
    .optional()
    .describe(
      "Optional cron schedule that auto-refreshes a 'parquet' binding. Only " +
        "applies when materialization is 'parquet' (ignored/disabled for " +
        "'live'). You can also set or change this later with " +
        "app_set_binding_schedule.",
    ),
});

export const deleteDataBindingSchema = z.object({
  appId: appIdField,
  name: z
    .string()
    .describe("Name of the data binding to delete (from list_data_sources)"),
});

export const saveAppVersionSchema = z.object({
  appId: appIdField,
  comment: z
    .string()
    .optional()
    .describe(
      "Short message describing this checkpoint, e.g. 'Add revenue chart'. " +
        "Shown in the version history list.",
    ),
});

export const restoreAppVersionSchema = z.object({
  appId: appIdField,
  version: z
    .number()
    .describe(
      "Version number to restore (from browse_version_history). The current " +
        "state is preserved as a new checkpoint, so a restore is never lossy.",
    ),
  comment: z
    .string()
    .optional()
    .describe("Optional note explaining why this version was restored."),
});

// Schemas for the server-executed app tools (registered with execute functions
// in api/src/agent-lib/tools/server-app-tools.ts). Apps are fully
// server-authoritative: list/create/read/inspect/materialize all run against
// the MakoApp document so a headless / detached agent never needs a browser.
export const listAppsSchema = z.object({});

export const createAppSchema = z.object({
  title: z.string().describe("App title"),
  description: z.string().optional().describe("Brief description"),
});

export const getAppStateSchema = z.object({ appId: appIdField });

export { readFileSchema as appReadFileSchema };

export const setBindingScheduleSchema = z.object({
  appId: appIdField,
  name: z
    .string()
    .describe(
      "Name of the parquet binding to schedule (from list_data_sources)",
    ),
  enabled: z.boolean().describe("Turn the scheduled auto-refresh on or off"),
  cron: z
    .string()
    .nullable()
    .optional()
    .describe(
      "5-field cron expression. Required when enabling. E.g. '0 * * * *' = " +
        "hourly, '0 */6 * * *' = every 6h, '0 0 * * *' = daily.",
    ),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for the cron (defaults to UTC)"),
  dataFreshnessTtlMs: z
    .number()
    .nullable()
    .optional()
    .describe("Optional freshness window in ms used for staleness badges"),
});

export const setBindingMaterializationSchema = z.object({
  appId: appIdField,
  name: z
    .string()
    .describe(
      "Name of the existing data binding to switch (from list_data_sources)",
    ),
  materialization: z
    .enum(["live", "parquet"])
    .describe(
      "'live' runs the query server-side on every read; 'parquet' materializes " +
        "the query to a Parquet artifact loaded into DuckDB-WASM in the browser. " +
        "Toggles the setting on the existing binding IN PLACE — no need to " +
        "delete and recreate. After switching to 'parquet', call " +
        "materialize_binding to build the artifact.",
    ),
  materializationSchedule: bindingMaterializationScheduleSchema
    .optional()
    .describe(
      "Optional cron schedule to set at the same time. Only applies when " +
        "switching to 'parquet' (forced disabled for 'live'). Can also be set " +
        "later with app_set_binding_schedule.",
    ),
});

export const materializeBindingSchema = z.object({
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

// Client-executed legs only: these depend on the browser preview (sandboxed
// iframe) and the live UI tabs, so they cannot run server-side. A headless
// agent simply does not call them — it operates on `appId` directly.
export const clientAppTools = {
  open_app: tool({
    description:
      "Open a saved app by its ID into a tab in the UI and load its files. " +
      "UI convenience for an attached browser; headless flows can skip this and " +
      "pass the appId directly to other tools.",
    inputSchema: z.object({ appId: z.string().describe("App ID to open") }),
  }),
  run_app: tool({
    description:
      "Rebuild and reload the app's LIVE PREVIEW in the browser and return any " +
      "build/runtime errors. This is the only browser-only app tool — use it to " +
      "validate that edits render and to read preview errors. Requires an " +
      "attached browser tab; it is not needed to author or persist an app.",
    inputSchema: z.object({ appId: appIdField }),
  }),
};

export type AppWriteFileInput = z.infer<typeof writeFileSchema>;
export type AppCreateDataBindingInput = z.infer<typeof createDataBindingSchema>;
