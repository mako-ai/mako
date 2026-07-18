/**
 * Tool discovery meta-tools: `search_tools` and `load_tools`.
 *
 * Deferred-tier tools (all MCP connector tools plus rarely-used built-ins)
 * are registered but not sent to the provider. The model finds them with
 * `search_tools` (compact cards, no schemas) and activates them with
 * `load_tools` — which live-mutates the per-request `ModeState` exactly like
 * `enable_mode` does, so `prepareStep` includes them in `activeTools` on the
 * next step and the provider receives their full schemas natively.
 *
 * `load_tools` calls are also the replay markers `deriveModeState` uses to
 * statelessly reconstruct the working set from the transcript.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ModeState } from "../../agents/modes/types";
import { searchToolCatalog, type ToolCatalogEntry } from "../tool-catalog";

const searchToolsSchema = z.object({
  query: z
    .string()
    .describe(
      "What you want to do, e.g. 'send slack message' or 'close crm leads'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max results (default 10)."),
});

const loadToolsSchema = z.object({
  names: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe("Exact tool names from search_tools results to activate."),
});

/** Build the search_tools note so already-loaded hits don't re-trigger load loops. */
export function buildSearchToolsNote(params: {
  hitCount: number;
  unloadedCount: number;
  loadedCount: number;
}): string {
  const { hitCount, unloadedCount, loadedCount } = params;
  if (hitCount === 0) {
    return "No matching tools. Try different terms (e.g. the connector's name) — or the capability may not be connected to this workspace.";
  }
  if (unloadedCount === 0) {
    return (
      "Matching tool(s) are already active — call them directly now. " +
      "Do NOT call load_tools again for these names."
    );
  }
  if (loadedCount === 0) {
    return "Call load_tools with the exact names you need; their full input schemas become available on your next step. Then call the tool itself — do not keep searching.";
  }
  return (
    "Some matches are already active (call those directly). " +
    "For the rest, call load_tools once with the exact unloaded names, then call the tool itself."
  );
}

/** Build the load_tools note so alreadyLoaded doesn't look like a no-op failure. */
export function buildLoadToolsNote(params: {
  loadedNow: string[];
  alreadyActive: string[];
  unknown: string[];
}): string | undefined {
  const { loadedNow, alreadyActive, unknown } = params;
  if (
    unknown.length > 0 &&
    loadedNow.length === 0 &&
    alreadyActive.length === 0
  ) {
    return undefined;
  }
  if (loadedNow.length > 0 && alreadyActive.length === 0) {
    return "Loaded. Call these tools directly on your next step — do not call load_tools again for the same names.";
  }
  if (loadedNow.length === 0 && alreadyActive.length > 0) {
    return (
      "Already active — call them directly now (schemas are already available). " +
      "Do NOT call load_tools or search_tools again for these names."
    );
  }
  if (loadedNow.length > 0 && alreadyActive.length > 0) {
    return (
      "Some tools were loaded and some were already active. " +
      "Call all of them directly on your next step — do not call load_tools again for these names."
    );
  }
  return undefined;
}

/**
 * Create the discovery meta-tools bound to a per-request mutable `ModeState`
 * and the request's tool catalog (deferred entries only — core and mode
 * tools are already active and never need loading).
 */
export function createToolDiscoveryTools(params: {
  modeState: ModeState;
  catalog: ToolCatalogEntry[];
}) {
  const { modeState, catalog } = params;
  const deferredByName = new Map(
    catalog.filter(e => e.tier === "deferred").map(e => [e.name, e]),
  );

  return {
    search_tools: tool({
      description:
        "Search the workspace's full tool catalog (connected MCP servers + " +
        "additional built-ins) for tools that are not currently loaded. " +
        "Returns compact matches; activate unloaded ones with load_tools, " +
        "then call the tool itself. If a result already has loaded:true, " +
        "call that tool directly — do not load_tools again. " +
        "Use this whenever the user asks for something your current tools " +
        "don't cover — never guess tool names.",
      inputSchema: searchToolsSchema,
      execute: async ({ query, limit }: z.infer<typeof searchToolsSchema>) => {
        const hits = searchToolCatalog(catalog, query, limit ?? 10);
        const loaded = new Set(modeState.loadedToolNames);
        const results = hits.map(hit => ({
          name: hit.name,
          description: hit.description,
          source: hit.source,
          readOnly: hit.readOnly,
          loaded: loaded.has(hit.name),
        }));
        const loadedCount = results.filter(r => r.loaded).length;
        return {
          success: true,
          results,
          note: buildSearchToolsNote({
            hitCount: results.length,
            unloadedCount: results.length - loadedCount,
            loadedCount,
          }),
        };
      },
    }),

    load_tools: tool({
      description:
        "Activate tools found via search_tools so they become callable on " +
        "your next step. Load only what you need — the working set is " +
        "bounded and rarely-used tools are evicted first. If a tool is " +
        "alreadyLoaded, call it directly — do not keep calling load_tools.",
      inputSchema: loadToolsSchema,
      execute: async ({ names }: z.infer<typeof loadToolsSchema>) => {
        const loadedNow: string[] = [];
        const alreadyActive: string[] = [];
        const unknown: string[] = [];

        for (const name of names) {
          const entry = deferredByName.get(name);
          if (!entry) {
            unknown.push(name);
            continue;
          }
          const idx = modeState.loadedToolNames.indexOf(name);
          if (idx !== -1) {
            // Re-load refreshes LRU position (moves to newest).
            modeState.loadedToolNames.splice(idx, 1);
            modeState.loadedToolNames.push(name);
            alreadyActive.push(name);
            continue;
          }
          modeState.loadedToolNames.push(name);
          loadedNow.push(name);
        }

        return {
          success: unknown.length === 0,
          loaded: loadedNow,
          alreadyLoaded: alreadyActive,
          ...(unknown.length > 0
            ? {
                unknownNames: unknown,
                error:
                  "Unknown tool name(s). Use exact names from search_tools results — do not guess.",
              }
            : {}),
          note: buildLoadToolsNote({ loadedNow, alreadyActive, unknown }),
        };
      },
    }),
  };
}

/** Names of the discovery meta-tools (core tier, plan-gate allowed). */
export const TOOL_DISCOVERY_TOOL_NAMES = [
  "search_tools",
  "load_tools",
] as const;
