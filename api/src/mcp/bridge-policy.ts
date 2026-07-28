/**
 * MCP ↔ agent tool bridge policy.
 *
 * The in-product agent and Mako's MCP server share server-side tool
 * factories, but MCP deliberately exposes a curated subset (headless,
 * read-only data access, apps loop). This module is the single place that
 * says, for every known agent tool name:
 *
 *   - bridge it over MCP, or
 *   - exclude it, with an explicit why + note
 *
 * Adding a new agent tool without classifying it here fails the MCP
 * inventory test — that's how we stay smart about what's missing.
 */
import {
  AGENT_CAPABILITIES,
  READ_ONLY_TOOL_NAMES,
  type AgentCapabilityDefinition,
} from "@mako/agent-tools";

/** Why a tool is kept off the MCP surface. */
export type McpBridgeExclusionWhy =
  | "client-only"
  | "security"
  | "in-product-only"
  | "deferred";

export type McpBridgeEntry =
  | {
      status: "bridge";
      /** Omit when the API key has no query access (`query:read`). */
      requiresQueryAccess?: boolean;
      /** Expose only to the signed-in Mako Desktop ACP client. */
      acpDesktopOnly?: boolean;
      /**
       * Omit for Desktop ACP clients: the mako-desktop loopback server
       * delivers this same tool name there (one name, one provider).
       */
      omitForAcpDesktop?: boolean;
      /**
       * Factory may omit this tool without credentials/config (e.g. web_search
       * when no search provider is configured). Still classified so the catalog
       * stays complete; inventory/staleness checks treat it as optional.
       */
      conditional?: boolean;
      /** MCP annotation — defaults from READ_ONLY_TOOL_NAMES + special cases. */
      openWorldHint?: boolean;
      destructiveHint?: boolean;
    }
  | {
      status: "exclude";
      why: McpBridgeExclusionWhy;
      note: string;
    }
  | {
      /** Exists only on the MCP server (not the in-product agent). */
      status: "mcp-only";
      openWorldHint?: boolean;
      destructiveHint?: boolean;
    };

const bridge = (
  opts: Omit<Extract<McpBridgeEntry, { status: "bridge" }>, "status"> = {},
): McpBridgeEntry => ({ status: "bridge", ...opts });

const exclude = (why: McpBridgeExclusionWhy, note: string): McpBridgeEntry => ({
  status: "exclude",
  why,
  note,
});

const mcpOnly = (
  opts: Omit<Extract<McpBridgeEntry, { status: "mcp-only" }>, "status"> = {},
): McpBridgeEntry => ({ status: "mcp-only", ...opts });

function capabilityBridgePolicyEntries(
  capabilities: readonly AgentCapabilityDefinition[],
): Record<string, McpBridgeEntry> {
  return Object.fromEntries(
    capabilities.map(capability => {
      if (capability.requiresAsyncMcp) {
        return [
          capability.name,
          exclude(
            "deferred",
            "Move this operation to the async run lifecycle before MCP exposure.",
          ),
        ];
      }

      const external = capability.surfaces.includes("external-mcp");
      const desktop = capability.surfaces.includes("desktop-acp");
      if (external) {
        return [
          capability.name,
          bridge({
            requiresQueryAccess: capability.requiresQueryAccess,
            destructiveHint: capability.risk === "destructive",
            omitForAcpDesktop:
              capability.desktopDelivery === "mako-desktop" || undefined,
          }),
        ];
      }
      if (desktop && capability.desktopDelivery === "mako-desktop") {
        // Desktop ACP gets this tool from the mako-desktop loopback server;
        // the Mako bridge never serves it on any MCP surface.
        return [
          capability.name,
          exclude(
            capability.mcpExclusion?.why ?? "client-only",
            capability.mcpExclusion?.note ??
              "Delivered by the mako-desktop loopback server on Desktop ACP.",
          ),
        ];
      }
      if (desktop) {
        return [
          capability.name,
          bridge({
            acpDesktopOnly: true,
            requiresQueryAccess: capability.requiresQueryAccess,
            destructiveHint: capability.risk === "destructive",
          }),
        ];
      }
      if (capability.mcpExclusion) {
        return [
          capability.name,
          exclude(capability.mcpExclusion.why, capability.mcpExclusion.note),
        ];
      }
      return [
        capability.name,
        exclude("deferred", "Not available on an MCP surface."),
      ];
    }),
  );
}

/**
 * Complete classification of every agent / MCP tool name.
 * Keep alphabetical within each section so diffs stay reviewable.
 */
export const MCP_BRIDGE_POLICY: Readonly<Record<string, McpBridgeEntry>> = {
  // ── Apps / notebooks / consoles / SQL / Mongo / dbt — derived from the
  //    shared capability registry (@mako/agent-tools capabilities/*) ───────
  ...capabilityBridgePolicyEntries(AGENT_CAPABILITIES),

  // ── MCP-only preview / render ─────────────────────────────────────────
  create_preview_token: mcpOnly(),
  render_app: mcpOnly(),

  // ── Charts / screenshots (client) ─────────────────────────────────────
  capture_screenshot: exclude(
    "client-only",
    "Captures the open browser tab; MCP uses render_app screenshots.",
  ),
  get_chart_template: exclude(
    "client-only",
    "Chart templates are a console/dashboard UI concern.",
  ),
  get_chart_templates: exclude(
    "client-only",
    "Dashboard chart template catalog; not part of the apps MCP loop.",
  ),
  modify_chart_spec: exclude(
    "client-only",
    "Mutates the open console chart in the browser.",
  ),

  // ── Flow / sync (mostly UI + deferred) ────────────────────────────────
  create_flow_tab: exclude(
    "client-only",
    "Flow editor tab management requires the browser.",
  ),
  execute_query: exclude(
    "deferred",
    "Unnamespaced mongo/flow execute alias; MCP uses sql_execute_query and never bridges mongo_execute_query.",
  ),
  explain_template: exclude(
    "deferred",
    "Flow template placeholder docs; not needed for apps authoring.",
  ),
  get_form_state: exclude("client-only", "Reads the open flow form in the UI."),
  inspect_collection: exclude(
    "deferred",
    "Unnamespaced mongo alias; MCP uses mongo_inspect_collection.",
  ),
  inspect_table: exclude(
    "deferred",
    "Unnamespaced flow discovery duplicate of sql_inspect_table.",
  ),
  list_collections: exclude(
    "deferred",
    "Unnamespaced mongo alias; MCP uses mongo_list_collections.",
  ),
  list_databases: exclude(
    "deferred",
    "Unnamespaced mongo/flow discovery alias; MCP uses sql_list_databases / mongo_list_databases.",
  ),
  list_flow_tabs: exclude("client-only", "Lists open flow editor tabs."),
  list_tables: exclude(
    "deferred",
    "Unnamespaced flow discovery duplicate of sql_list_tables.",
  ),
  set_form_field: exclude(
    "client-only",
    "Writes the open flow form in the UI.",
  ),
  set_multiple_fields: exclude(
    "client-only",
    "Writes the open flow form in the UI.",
  ),
  validate_query: exclude(
    "deferred",
    "Flow sync validation; MCP uses sql_execute_query for query checks.",
  ),

  // ── Dashboards (client mutations + server search) ─────────────────────
  add_data_source: exclude(
    "client-only",
    "Dashboard builder is browser-driven; MCP focuses on apps.",
  ),
  add_global_filter: exclude("client-only", "Dashboard builder UI."),
  add_widget: exclude("client-only", "Dashboard builder UI."),
  create_dashboard: exclude("client-only", "Dashboard builder UI."),
  create_data_source: exclude("client-only", "Dashboard builder UI."),
  dashboard_restore_version: exclude(
    "deferred",
    "Dashboard versioning stays in-product until dashboards are MCP-bridged.",
  ),
  dashboard_save_version: exclude(
    "deferred",
    "Dashboard versioning stays in-product until dashboards are MCP-bridged.",
  ),
  enter_edit_mode: exclude("client-only", "Dashboard builder UI."),
  get_dashboard_state: exclude(
    "client-only",
    "Reads open dashboard tab state.",
  ),
  import_console_as_data_source: exclude(
    "client-only",
    "Dashboard builder UI.",
  ),
  link_tables: exclude("client-only", "Dashboard builder UI."),
  list_open_dashboards: exclude(
    "client-only",
    "Lists open dashboard tabs; MCP uses search_dashboards.",
  ),
  modify_widget: exclude("client-only", "Dashboard builder UI."),
  open_dashboard: exclude("client-only", "Opens a dashboard tab."),
  remove_global_filter: exclude("client-only", "Dashboard builder UI."),
  remove_widget: exclude("client-only", "Dashboard builder UI."),
  run_data_source_query: exclude("client-only", "Dashboard builder UI."),
  search_dashboards: bridge(),
  set_time_dimension: exclude("client-only", "Dashboard builder UI."),
  update_data_source_query: exclude("client-only", "Dashboard builder UI."),

  // ── Shared DuckDB data-source primitives (client) ─────────────────────
  inspect_data_source: exclude(
    "client-only",
    "Inspects in-browser DuckDB materializations.",
  ),
  list_data_sources: exclude(
    "client-only",
    "Lists in-browser DuckDB materializations.",
  ),
  query_duckdb: exclude(
    "client-only",
    "Queries in-browser DuckDB; MCP validates via sql_execute_query.",
  ),

  // ── Skills / memory / modes / plan ────────────────────────────────────
  ask_clarifying_questions: exclude(
    "in-product-only",
    "Plan UX is chat-UI specific.",
  ),
  delete_skill: exclude(
    "in-product-only",
    "Skill writes stay in-product; MCP is read-only for skills.",
  ),
  enable_mode: exclude(
    "in-product-only",
    "Expertise modes are the in-product agent runtime.",
  ),
  get_relevant_skills: bridge(),
  list_skills: bridge(),
  load_skill: bridge(),
  load_tools: exclude(
    "in-product-only",
    "Deferred-tool working set is the in-product agent runtime; MCP exposes a fixed curated surface.",
  ),
  read_self_directive: bridge(),
  read_skill_resource: bridge(),
  save_skill: exclude(
    "in-product-only",
    "Skill writes stay in-product; MCP is read-only for skills.",
  ),
  search_skills: bridge(),
  search_tools: exclude(
    "in-product-only",
    "Deferred-tool working set is the in-product agent runtime; MCP exposes a fixed curated surface.",
  ),
  submit_plan: exclude("in-product-only", "Plan UX is chat-UI specific."),
  todo_write: exclude(
    "in-product-only",
    "In-product agent todo list; external MCP clients have their own planning.",
  ),
  update_self_directive: bridge(),

  // ── Version history ───────────────────────────────────────────────────
  browse_version_history: bridge(),
  get_version_snapshot: bridge(),

  // ── Web ───────────────────────────────────────────────────────────────
  fetch_url: bridge({ openWorldHint: true }),
  // Only registered when a web-search provider is configured
  // (see createWebTools); still classified so the gap catalog stays complete.
  web_search: bridge({ openWorldHint: true, conditional: true }),
};

/** Tools the MCP server should register (bridged + mcp-only). */
export function mcpExposedToolNames(): string[] {
  return Object.entries(MCP_BRIDGE_POLICY)
    .filter(
      ([, entry]) => entry.status === "bridge" || entry.status === "mcp-only",
    )
    .map(([name]) => name)
    .sort();
}

/** Agent tools intentionally not on MCP, grouped by why. */
export function summarizeBridgeGaps(): Array<{
  why: McpBridgeExclusionWhy;
  tools: Array<{ name: string; note: string }>;
}> {
  const byWhy = new Map<
    McpBridgeExclusionWhy,
    Array<{ name: string; note: string }>
  >();
  for (const [name, entry] of Object.entries(MCP_BRIDGE_POLICY)) {
    if (entry.status !== "exclude") continue;
    const list = byWhy.get(entry.why) ?? [];
    list.push({ name, note: entry.note });
    byWhy.set(entry.why, list);
  }
  return (["security", "client-only", "in-product-only", "deferred"] as const)
    .filter(why => byWhy.has(why))
    .map(why => ({
      why,
      tools: (byWhy.get(why) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
}

/**
 * Fail if `toolNames` contains anything not classified in the policy.
 * Call with the live inventory from factories + client packages.
 */
export function assertBridgePolicyCovers(toolNames: Iterable<string>): void {
  const missing: string[] = [];
  for (const name of toolNames) {
    if (!(name in MCP_BRIDGE_POLICY)) missing.push(name);
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(
      `MCP bridge policy is missing classifications for: ${missing.join(", ")}. ` +
        "Add each to MCP_BRIDGE_POLICY as bridge / exclude / mcp-only so we stay smart about gaps.",
    );
  }
}

/**
 * Fail if the policy references tool names that no longer exist in the live
 * inventory (except mcp-only entries, which are not agent tools, and
 * conditional bridges that are only registered when optional deps exist).
 */
export function assertBridgePolicyNotStale(
  liveToolNames: Iterable<string>,
): void {
  const live = new Set(liveToolNames);
  const stale: string[] = [];
  for (const [name, entry] of Object.entries(MCP_BRIDGE_POLICY)) {
    if (entry.status === "mcp-only") continue;
    if (entry.status === "bridge" && entry.conditional) continue;
    if (!live.has(name)) stale.push(name);
  }
  if (stale.length > 0) {
    stale.sort();
    throw new Error(
      `MCP bridge policy has stale entries (no longer in agent inventory): ${stale.join(", ")}.`,
    );
  }
}

/**
 * MCP readOnlyHint: prefer the shared agent-tools set, plus MCP-only reads,
 * plus the query:read envelope for sql_execute_query / run_console.
 */
export function mcpReadOnlyHint(
  name: string,
  queryAccess: "none" | "read" | "write",
): boolean {
  if (READ_ONLY_TOOL_NAMES.has(name)) return true;
  const entry = MCP_BRIDGE_POLICY[name];
  if (entry?.status === "mcp-only") {
    // Preview/render tools never mutate workspace definitions beyond reads.
    return true;
  }
  if (
    queryAccess === "read" &&
    (name === "sql_execute_query" ||
      name === "run_console" ||
      name === "cancel_query")
  ) {
    // Under query:read the SQL loop is forced read-only; cancel is part of
    // that same lifecycle and should not look like a write to MCP clients
    // (affects auto-approval annotations). check_query_status and
    // list_console_executions are read-risk in the capability registry, so
    // they are covered by READ_ONLY_TOOL_NAMES above regardless of scope.
    return true;
  }
  return false;
}

export function mcpDestructiveHint(name: string): boolean {
  const entry = MCP_BRIDGE_POLICY[name];
  if (!entry || entry.status === "exclude") return false;
  return entry.destructiveHint === true;
}

export function mcpOpenWorldHint(name: string): boolean {
  const entry = MCP_BRIDGE_POLICY[name];
  if (!entry || entry.status === "exclude") return false;
  return entry.openWorldHint === true;
}
