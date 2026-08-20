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

import {
  runAppBaseSchema,
  RUN_APP_MIN_VIEWPORT_PX,
  RUN_APP_MAX_VIEWPORT_PX,
} from "./run-app";

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

export const editFileSchema = z.object({
  appId: appIdField,
  path: z
    .string()
    .describe("POSIX file path relative to project root, e.g. src/App.tsx"),
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
  expectedResourceVersion: z
    .string()
    .optional()
    .describe(
      "Resource version returned by get_app_state, app_search, or " +
        "app_read_resource. The edit is rejected if the file changed since read.",
    ),
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
    .optional()
    .describe(
      "Binding name referenced from app code via useQuery(name). Required " +
        "unless consoleId is given (then defaults to the console's name).",
    ),
  consoleId: z
    .string()
    .optional()
    .describe(
      "Import a saved console by ID (from search_consoles): its query code, " +
        "connection, language, and database resolve server-side, so you do " +
        "not need to re-type the SQL. Explicit fields below override the " +
        "console's values.",
    ),
  connectionId: z
    .string()
    .optional()
    .describe(
      "Workspace connection ID to run the query against (required unless " +
        "consoleId is given)",
    ),
  language: z.enum(["sql", "javascript", "mongodb"]).optional(),
  code: z
    .string()
    .optional()
    .describe(
      "Query text/code to execute server-side (required unless consoleId " +
        "is given)",
    ),
  databaseId: z.string().optional(),
  databaseName: z.string().optional(),
  dbtProjectId: z
    .string()
    .optional()
    .describe(
      "Link the binding to a dbt project (from read_dbt_project_tree). When " +
        "set, write the query against the {{ dbt_schema }} token instead of " +
        "hardcoding a schema (e.g. SELECT * FROM {{ dbt_schema }}.fct_orders); " +
        "it resolves to the project's PROD environment schema for published " +
        "apps/materialization, and to the editor's preview environment " +
        "override in the draft preview.",
    ),
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
        "app_update_data_binding.",
    ),
});

export const updateDataBindingSchema = z.object({
  appId: appIdField,
  name: z
    .string()
    .describe(
      "Name of the EXISTING data binding to update (from list_data_sources)",
    ),
  code: z
    .string()
    .optional()
    .describe(
      "Full replacement query text/code. For small changes prefer " +
        "oldString/newString instead of re-sending the whole query.",
    ),
  oldString: z
    .string()
    .optional()
    .describe(
      "Anchored edit of the current query: exact text to replace (must " +
        "match exactly once). Mutually exclusive with code.",
    ),
  newString: z
    .string()
    .optional()
    .describe("Replacement text for oldString (\"\" deletes the match)."),
  connectionId: z
    .string()
    .optional()
    .describe("Move the binding to a different workspace connection"),
  language: z.enum(["sql", "javascript", "mongodb"]).optional(),
  databaseId: z.string().optional(),
  databaseName: z.string().optional(),
  dbtProjectId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Link the binding to a dbt project (enables the {{ dbt_schema }} " +
        "token in code) or pass null to unlink it.",
    ),
  materialization: z
    .enum(["live", "parquet"])
    .optional()
    .describe(
      "Switch the binding's materialization IN PLACE (preserves its id, " +
        "code, connection, and artifact history). 'live' runs the query " +
        "server-side on every read; 'parquet' materializes it to a Parquet " +
        "artifact for client-side DuckDB analytics — after switching to " +
        "'parquet', call materialize_binding to build the artifact.",
    ),
  materializationSchedule: bindingMaterializationScheduleSchema
    .optional()
    .describe(
      "Set or clear the cron auto-refresh on a 'parquet' binding, e.g. " +
        "{ enabled: true, cron: '0 * * * *' } for hourly or " +
        "{ enabled: false } to turn it off. Requires the binding to be (or " +
        "become, via materialization in the same call) 'parquet'.",
    ),
  expectedResourceVersion: z
    .string()
    .optional()
    .describe(
      "Resource version returned by get_app_state, app_search, or " +
        "app_read_resource. The update is rejected if the binding changed since read.",
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

export const getAppStateSchema = z.object({
  appId: appIdField,
  resourceOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Resource manifest offset (default 0)."),
  resourceLimit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum manifest entries to return (default 100, max 200)."),
});

export { readFileSchema as appReadFileSchema };

export const appReadResourceSchema = z.object({
  appId: appIdField,
  resource: z
    .string()
    .describe(
      'Resource ref from get_app_state, e.g. "file:src/App.tsx" or "binding:revenue".',
    ),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First 1-based line to return (default 1)."),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Last 1-based line to return. Responses are still bounded by the tool budget.",
    ),
  startOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional 0-based character offset. When set, uses character pagination " +
        "instead of line pagination (useful for generated/minified single lines).",
    ),
});

export const appSearchSchema = z.object({
  appId: appIdField,
  query: z
    .string()
    .min(1)
    .describe("Literal, case-insensitive text to find in app files and bindings."),
  resourceTypes: z
    .array(z.enum(["file", "binding"]))
    .optional()
    .describe("Limit search to files and/or bindings (default both)."),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Context lines before and after each match (default 3)."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum matches to return (default 20)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of matching occurrences to skip (default 0)."),
});

/** Max chars of SQL/JS kept on get_app_state binding summaries (not full code). */
export const APP_STATE_CODE_PREVIEW_CHARS = 160;

/** Caps for intentional full-read tools — keep agent/MCP context budgets honest. */
export const APP_READ_FILE_MAX_CHARS = 16_000;
/** inspect_data_source / list previews — use app_read_resource for full ranges. */
export const APP_INSPECT_CODE_PREVIEW_CHARS = 2_000;
export const APP_PREVIEW_ERROR_MAX = 20;
export const APP_PREVIEW_ERROR_CHARS = 2_000;
export const APP_SAMPLE_CELL_MAX_CHARS = 200;
export const APP_RESOURCE_MAX_LINES = 400;
export const APP_RESOURCE_MAX_CHARS = 16_000;
export const APP_SEARCH_MAX_OUTPUT_CHARS = 20_000;
export const APP_SEARCH_SNIPPET_MAX_CHARS = 4_000;

export type AppResourceKind = "file" | "binding";

export function appResourceRef(kind: AppResourceKind, name: string): string {
  return `${kind}:${name}`;
}

export function parseAppResourceRef(
  resource: string,
): { kind: AppResourceKind; name: string } | null {
  const separator = resource.indexOf(":");
  if (separator <= 0) return null;
  const kind = resource.slice(0, separator);
  const name = resource.slice(separator + 1);
  if ((kind !== "file" && kind !== "binding") || !name) return null;
  return { kind, name };
}

/** Stable, lightweight concurrency token for one file/binding body. */
export function appResourceVersion(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Include the app's monotonic version in concurrency tokens. The hash keeps
 * tokens resource-specific; the app version makes collisions harmless.
 */
export function appVersionedResourceVersion(
  appVersion: number,
  resourceVersion: string,
): string {
  return `${appVersion}:${resourceVersion}`;
}

export function appBindingResourceVersion(binding: {
  code?: string | null;
  connectionId?: string | null;
  language?: string | null;
  databaseId?: string | null;
  databaseName?: string | null;
  dbtProjectId?: string | null;
}): string {
  return appResourceVersion(
    JSON.stringify({
      code: binding.code ?? "",
      connectionId: binding.connectionId ?? null,
      language: binding.language ?? "sql",
      databaseId: binding.databaseId ?? null,
      databaseName: binding.databaseName ?? null,
      dbtProjectId: binding.dbtProjectId ?? null,
    }),
  );
}

export function readAppResourceRange(
  text: string,
  startLineInput?: number,
  endLineInput?: number,
  startOffsetInput?: number,
): {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  startOffset?: number;
  endOffset?: number;
  nextOffset?: number;
  hasMore: boolean;
  nextStartLine?: number;
  contentTruncated: boolean;
} {
  if (startOffsetInput !== undefined) {
    const startOffset = Math.min(Math.max(startOffsetInput, 0), text.length);
    const endOffset = Math.min(
      startOffset + APP_RESOURCE_MAX_CHARS,
      text.length,
    );
    const content = text.slice(startOffset, endOffset);
    const startLine = text.slice(0, startOffset).split("\n").length;
    const endLine = startLine + content.split("\n").length - 1;
    const hasMore = endOffset < text.length;
    return {
      content,
      startLine,
      endLine,
      totalLines: text.split("\n").length,
      startOffset,
      endOffset,
      ...(hasMore ? { nextOffset: endOffset } : {}),
      hasMore,
      contentTruncated: hasMore,
    };
  }

  const lines = text.split("\n");
  const totalLines = lines.length;
  const startLine = Math.min(Math.max(startLineInput ?? 1, 1), totalLines);
  const requestedEnd = Math.max(endLineInput ?? startLine + 199, startLine);
  const protocolEnd = Math.min(
    requestedEnd,
    startLine + APP_RESOURCE_MAX_LINES - 1,
  );
  let endLine = Math.min(protocolEnd, totalLines);
  let selected = lines.slice(startLine - 1, endLine);
  let content = selected.join("\n");
  let contentTruncated = protocolEnd < requestedEnd;
  let characterStartOffset: number | undefined;
  let characterEndOffset: number | undefined;

  while (content.length > APP_RESOURCE_MAX_CHARS && selected.length > 1) {
    selected = selected.slice(0, -1);
    endLine -= 1;
    content = selected.join("\n");
    contentTruncated = true;
  }
  if (content.length > APP_RESOURCE_MAX_CHARS) {
    characterStartOffset =
      lines
        .slice(0, startLine - 1)
        .reduce((sum, line) => sum + line.length + 1, 0);
    characterEndOffset = Math.min(
      characterStartOffset + APP_RESOURCE_MAX_CHARS,
      text.length,
    );
    content = text.slice(characterStartOffset, characterEndOffset);
    contentTruncated = true;
  }

  const hasCharacterContinuation =
    characterEndOffset !== undefined && characterEndOffset < text.length;
  const hasMore = endLine < totalLines || hasCharacterContinuation;
  return {
    content,
    startLine,
    endLine,
    totalLines,
    ...(characterStartOffset !== undefined
      ? {
          startOffset: characterStartOffset,
          endOffset: characterEndOffset,
          ...(hasCharacterContinuation
            ? { nextOffset: characterEndOffset }
            : {}),
        }
      : {}),
    hasMore,
    ...(endLine < totalLines && !hasCharacterContinuation
      ? { nextStartLine: endLine + 1 }
      : {}),
    contentTruncated,
  };
}

export interface AppSearchableResource<TKind extends string = AppResourceKind> {
  resource: string;
  kind: TKind;
  name: string;
  text: string;
  resourceVersion?: string;
}

export function searchAppResources<TKind extends string = AppResourceKind>(
  resources: AppSearchableResource<TKind>[],
  query: string,
  options?: { contextLines?: number; maxResults?: number; offset?: number },
): {
  matches: Array<{
    resource: string;
    kind: TKind;
    name: string;
    line: number;
    startLine: number;
    endLine: number;
    snippet: string;
    resourceVersion: string;
  }>;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
} {
  const needle = query.toLocaleLowerCase();
  const contextLines = Math.min(Math.max(options?.contextLines ?? 3, 0), 10);
  const maxResults = Math.min(Math.max(options?.maxResults ?? 20, 1), 50);
  const offset = Math.max(options?.offset ?? 0, 0);
  const matches: Array<{
    resource: string;
    kind: TKind;
    name: string;
    line: number;
    startLine: number;
    endLine: number;
    snippet: string;
    resourceVersion: string;
  }> = [];
  let outputChars = 0;
  let truncated = false;
  let matchIndex = 0;

  outer: for (const resource of resources) {
    const lines = resource.text.split("\n");
    const version =
      resource.resourceVersion ?? appResourceVersion(resource.text);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.toLocaleLowerCase().includes(needle)) continue;
      if (matchIndex < offset) {
        matchIndex += 1;
        continue;
      }
      const startLine = Math.max(index + 1 - contextLines, 1);
      const endLine = Math.min(index + 1 + contextLines, lines.length);
      const rawSnippet = lines.slice(startLine - 1, endLine).join("\n");
      const matchColumn = lines[index]
        ?.toLocaleLowerCase()
        .indexOf(needle) ?? 0;
      const matchLine = lines[index] ?? "";
      const matchWindowStart = Math.max(
        matchColumn - Math.floor(APP_SEARCH_SNIPPET_MAX_CHARS / 2),
        0,
      );
      const snippet =
        rawSnippet.length > APP_SEARCH_SNIPPET_MAX_CHARS
          ? `${matchLine.slice(
              matchWindowStart,
              matchWindowStart + APP_SEARCH_SNIPPET_MAX_CHARS,
            )}\n…(line ${index + 1} clipped around match column ${matchColumn + 1})`
          : rawSnippet;
      if (
        matches.length >= maxResults ||
        outputChars + snippet.length > APP_SEARCH_MAX_OUTPUT_CHARS
      ) {
        truncated = true;
        break outer;
      }
      matches.push({
        resource: resource.resource,
        kind: resource.kind,
        name: resource.name,
        line: index + 1,
        startLine,
        endLine,
        snippet,
        resourceVersion: version,
      });
      outputChars += snippet.length;
      matchIndex += 1;
    }
  }
  return {
    matches,
    truncated,
    offset,
    ...(truncated ? { nextOffset: offset + matches.length } : {}),
  };
}

export function clipAgentText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; length: number } {
  const length = text.length;
  if (length <= maxChars) {
    return { text, truncated: false, length };
  }
  return {
    text: `${text.slice(0, maxChars)}\n…(truncated)`,
    truncated: true,
    length,
  };
}

/** Compact binding row for get_app_state — never ship full query text. */
export function summarizeAppBindingForState(binding: {
  name: string;
  connectionId?: string | null;
  dbtProjectId?: string | null;
  language?: string | null;
  materialization?: string | null;
  code?: string | null;
  databaseId?: string | null;
  databaseName?: string | null;
}): {
  resource: string;
  resourceVersion: string;
  name: string;
  connectionId?: string | null;
  dbtProjectId?: string | null;
  language: string;
  materialization: string;
  codeLength: number;
  codePreview: string;
} {
  const code = typeof binding.code === "string" ? binding.code : "";
  const preview =
    code.length <= APP_STATE_CODE_PREVIEW_CHARS
      ? code
      : `${code.slice(0, APP_STATE_CODE_PREVIEW_CHARS)}…`;
  return {
    resource: appResourceRef("binding", binding.name),
    resourceVersion: appBindingResourceVersion(binding),
    name: binding.name,
    connectionId: binding.connectionId,
    dbtProjectId: binding.dbtProjectId,
    language: binding.language || "sql",
    materialization: binding.materialization || "live",
    codeLength: code.length,
    codePreview: preview,
  };
}

/** Clip preview/runtime error lists before they enter agent context. */
export function summarizePreviewErrors(
  errors: Array<{ message?: string; source?: string }> | null | undefined,
): Array<{ message: string; source?: string }> {
  const list = Array.isArray(errors) ? errors : [];
  return list.slice(0, APP_PREVIEW_ERROR_MAX).map(e => {
    const raw = typeof e.message === "string" ? e.message : String(e.message ?? "");
    const clipped = clipAgentText(raw, APP_PREVIEW_ERROR_CHARS);
    return {
      message: clipped.text,
      ...(typeof e.source === "string" ? { source: e.source } : {}),
    };
  });
}

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
        "later with app_update_data_binding.",
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
      "Verify the app: rebuild and reload its LIVE PREVIEW, wait for it to " +
      "render, and return status, build/runtime errors, and a screenshot of " +
      "the rendered preview. Use after edits to confirm the app actually " +
      "works. Pass rebuild: false to read the current preview state without " +
      "forcing a rebuild, and includeScreenshot: false when you only need " +
      "status/errors (much cheaper).",
    inputSchema: runAppBaseSchema,
  }),
  app_set_preview: tool({
    description:
      "Configure the app's DRAFT PREVIEW: a device viewport (preset phone " +
      "390x844 / tablet 768x1024 / desktop = fill the pane, or custom " +
      "width/height — media queries re-evaluate, no rebuild) and/or which " +
      "dbt ENVIRONMENT it reads data from (for dbt-linked bindings using the " +
      "{{ dbt_schema }} token; null resets to prod). Pass at least one of " +
      "preset, width+height, or environment. This is per-user VIEW state — " +
      "it never changes the app definition or what published/shared viewers " +
      "see (those always read prod). While a dbt override is active, " +
      "dbt-linked parquet bindings serve a live (row-capped) run against the " +
      "override schema — do NOT call materialize_binding to preview dev data " +
      "(materialization always builds from prod). For a one-off size check " +
      "without changing what's on screen, pass width/height to run_app " +
      "instead.",
    inputSchema: z.object({
      appId: appIdField,
      preset: z
        .enum(["phone", "tablet", "desktop"])
        .optional()
        .describe(
          "Named viewport: phone 390x844, tablet 768x1024, desktop = clear " +
            "the override (fill the pane). Ignored when width/height are set.",
        ),
      width: z
        .number()
        .int()
        .min(RUN_APP_MIN_VIEWPORT_PX)
        .max(RUN_APP_MAX_VIEWPORT_PX)
        .optional()
        .describe("Custom viewport width in px (with height)"),
      height: z
        .number()
        .int()
        .min(RUN_APP_MIN_VIEWPORT_PX)
        .max(RUN_APP_MAX_VIEWPORT_PX)
        .optional()
        .describe("Custom viewport height in px (with width)"),
      environment: z
        .string()
        .nullable()
        .optional()
        .describe(
          "dbt environment name from the linked project (e.g. 'dev' or a " +
            "personal environment), or null to reset to the prod default. " +
            "Omit to leave the environment unchanged.",
        ),
    }),
  }),
  app_set_preview_environment: tool({
    description:
      "Deprecated alias of app_set_preview({ environment }) — switch which " +
      "dbt environment the app's draft preview reads data from.",
    inputSchema: z.object({
      appId: appIdField,
      environment: z
        .string()
        .nullable()
        .describe(
          "dbt environment name from the linked project (e.g. 'dev' or a " +
            "personal environment), or null to reset to the prod default",
        ),
    }),
  }),
  app_set_preview_viewport: tool({
    description:
      "Deprecated alias of app_set_preview({ preset | width+height }) — " +
      "switch the app's draft preview to a device viewport.",
    inputSchema: z.object({
      appId: appIdField,
      preset: z
        .enum(["phone", "tablet", "desktop"])
        .optional()
        .describe(
          "Named viewport: phone 390x844, tablet 768x1024, desktop = clear " +
            "the override (fill the pane). Ignored when width/height are set.",
        ),
      width: z
        .number()
        .int()
        .min(RUN_APP_MIN_VIEWPORT_PX)
        .max(RUN_APP_MAX_VIEWPORT_PX)
        .optional()
        .describe("Custom viewport width in px (with height)"),
      height: z
        .number()
        .int()
        .min(RUN_APP_MIN_VIEWPORT_PX)
        .max(RUN_APP_MAX_VIEWPORT_PX)
        .optional()
        .describe("Custom viewport height in px (with width)"),
    }),
  }),
};

export type AppWriteFileInput = z.infer<typeof writeFileSchema>;
export type AppEditFileInput = z.infer<typeof editFileSchema>;
export type AppCreateDataBindingInput = z.infer<typeof createDataBindingSchema>;
export type AppUpdateDataBindingInput = z.infer<typeof updateDataBindingSchema>;
