/**
 * Unified-agent mode runtime.
 *
 * Wires the expertise-mode registry + the model-initiated plan gate into a
 * single `streamText` loop via `prepareStep`: every step recomputes the active
 * tool allowlist and the (cached + dynamic) system blocks from a derived, then
 * live-mutated, `ModeState`.
 *
 * There is no user-facing plan/agent toggle. The model decides when planning
 * makes sense; once it calls `submit_plan` in the current user turn, mutating
 * tools are hard-gated until the user approves.
 */

import type { SystemModelMessage, ToolSet, UIMessage } from "ai";
import {
  clientPlanTools,
  READ_ONLY_TOOL_NAMES,
  PLAN_GATE_ALLOWED_TOOL_NAMES,
} from "@mako/agent-tools";
import type { AgentContext } from "../types";
import { unifiedAgentFactory } from "../unified";
import { buildCurrentScreenContext } from "../unified/prompt";
import { createModeTools } from "../../agent-lib/tools/mode-tools";
import { createToolDiscoveryTools } from "../../agent-lib/tools/tool-discovery-tools";
import {
  effectiveToolCountLimit,
  estimateToolSetTokens,
  preloadToolNames,
  MAX_ACTIVE_TOOLS,
  MAX_ACTIVE_TOOL_TOKENS,
  type ToolCatalogEntry,
} from "../../agent-lib/tool-catalog";
import {
  modeRegistry,
  defaultExpertiseMode,
  toolNamesForModes,
  resolveExpertiseModeId,
  DEFERRED_BUILTIN_TOOL_DOMAINS,
  builtinToolInventoryGroups,
} from "./registry";
import {
  BASE_SYSTEM_PROMPT,
  PLAN_GATE_SYSTEM_PROMPT,
  PLAN_EXECUTION_SYSTEM_PROMPT,
} from "./prompts";
import type { ExpertiseModeId, ModeState } from "./types";

/** The plan gate is engaged: a plan was submitted this turn but not approved. */
function isPlanGateActive(modeState: ModeState): boolean {
  return modeState.planSubmitted && !modeState.planApproved;
}

type UIMessagePart = {
  type?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
};

function partToolName(part: UIMessagePart): string | undefined {
  if (typeof part.type !== "string") return undefined;
  if (part.type === "dynamic-tool") return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

/**
 * Statelessly derive the mode state from the full message history. Consistent
 * with the "full context" model: enabled expertise modes are reconstructed
 * from prior `enable_mode` calls, and the plan gate from `submit_plan` calls
 * in the current user turn (latest decision wins).
 */
export function deriveModeState(
  messages: UIMessage[],
  defaultMode: ExpertiseModeId,
): ModeState {
  const enabledModes = new Set<ExpertiseModeId>([defaultMode]);
  const loadedToolNames: string[] = [];
  let planSubmitted = false;
  let planApproved = false;
  let lastPlanDecision: unknown;

  const recordLoadedTools = (names: unknown) => {
    if (!Array.isArray(names)) return;
    for (const name of names) {
      if (typeof name !== "string") continue;
      // Re-load moves the tool to the newest LRU position.
      const idx = loadedToolNames.indexOf(name);
      if (idx !== -1) loadedToolNames.splice(idx, 1);
      loadedToolNames.push(name);
    }
  };

  for (const message of messages) {
    // A new user turn normally starts a fresh plan cycle: any previous
    // submission or approval is stale for the new request. Exception
    // (conversational plan iteration, Cursor-style): when the latest plan was
    // resolved with request_changes, the following user message IS the
    // feedback — the gate stays engaged so the model revises and re-submits
    // instead of mutating. Enabled expertise modes are intentionally NOT
    // reset (they accumulate across the conversation).
    if (message.role === "user") {
      const isPlanIterationFeedback =
        planSubmitted &&
        !planApproved &&
        lastPlanDecision === "request_changes";
      if (!isPlanIterationFeedback) {
        planSubmitted = false;
      }
      planApproved = false;
    }

    const parts = (message.parts ?? []) as UIMessagePart[];
    for (const part of parts) {
      const toolName = partToolName(part);
      if (!toolName) continue;

      if (toolName === "enable_mode") {
        const mode = (part.input as { mode?: unknown } | undefined)?.mode;
        const resolved = resolveExpertiseModeId(mode);
        if (resolved) enabledModes.add(resolved);
      } else if (toolName === "load_tools") {
        // Deferred-tool loads persist across turns like modes. Unknown names
        // are harmless here: computeActiveTools intersects with the live
        // tool set, so stale loads (e.g. a disconnected MCP server) drop out.
        recordLoadedTools(
          (part.input as { names?: unknown } | undefined)?.names,
        );
      } else if (toolName === "submit_plan") {
        planSubmitted = true;
        const decision = (part.output as { decision?: unknown } | undefined)
          ?.decision;
        lastPlanDecision = decision;
        // The latest decision in this turn wins; only an explicit approval
        // unlocks writes. A pending submission (no output yet) stays gated.
        planApproved = decision === "approve";
      }
    }
  }

  return { enabledModes, planSubmitted, planApproved, loadedToolNames };
}

/**
 * Compact system-prompt inventory:
 * - every **built-in** tool name (no schemas), grouped by core / mode / deferred
 * - **MCP servers only** (name + count) — never individual MCP tool names
 *
 * Schemas for the active working set are already sent via the provider tools
 * API. This block exists so the model knows what else exists without paying
 * for those definitions. MCP tools must be discovered with `search_tools`.
 */
export function buildToolInventoryBlock(
  catalog: ToolCatalogEntry[],
  enabledModes: Iterable<ExpertiseModeId>,
): string {
  const enabled = new Set(enabledModes);
  const lines: string[] = [
    "## Tool inventory (names only)",
    "",
    "Schemas for **currently active** tools are already provided by the API.",
    "Names below are a map of what exists — do not invent names.",
    "",
  ];

  for (const group of builtinToolInventoryGroups()) {
    const modeMatch = /^(\w+) mode \(enable_mode/.exec(group.label);
    const modeId = modeMatch?.[1] as ExpertiseModeId | undefined;
    const active =
      group.label.startsWith("core ") ||
      (modeId !== undefined && enabled.has(modeId));
    const suffix = active
      ? " — active (schemas provided)"
      : group.label.startsWith("deferred")
        ? ""
        : " — not enabled; call enable_mode first";
    lines.push(`### ${group.label}${suffix}`);
    lines.push(group.names.map(n => `\`${n}\``).join(", "));
    lines.push("");
  }

  const mcpCounts = new Map<string, number>();
  for (const entry of catalog) {
    if (entry.source.kind === "mcp") {
      const key = entry.source.serverName;
      mcpCounts.set(key, (mcpCounts.get(key) ?? 0) + 1);
    }
  }

  lines.push("### MCP servers");
  if (mcpCounts.size === 0) {
    lines.push("None connected.");
  } else {
    lines.push(
      "Individual MCP tool names are **not** listed. Discover with " +
        "`search_tools`, activate with `load_tools`, then call — never guess " +
        "MCP tool names from the server name alone.",
    );
    for (const [server, count] of mcpCounts) {
      lines.push(`- ${server} (${count} tools via MCP)`);
    }
  }

  return lines.join("\n");
}

function buildModeSystem(
  context: AgentContext,
  modeState: ModeState,
  toolInventoryBlock?: string | null,
): SystemModelMessage[] {
  const dynamicParts: string[] = [];

  for (const modeId of modeState.enabledModes) {
    const mode = modeRegistry[modeId];
    if (mode?.systemPrompt) dynamicParts.push(mode.systemPrompt);
  }

  if (modeState.planSubmitted) {
    dynamicParts.push(
      modeState.planApproved
        ? PLAN_EXECUTION_SYSTEM_PROMPT
        : PLAN_GATE_SYSTEM_PROMPT,
    );
  }

  if (toolInventoryBlock) dynamicParts.push(toolInventoryBlock);

  dynamicParts.push(buildCurrentScreenContext(context));

  return [
    {
      role: "system",
      content: BASE_SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
      },
    },
    {
      role: "system",
      content: dynamicParts.join("\n\n---\n\n"),
    },
  ];
}

/** Working-set knobs for `computeActiveTools`. */
export interface WorkingSetOptions {
  /**
   * True when the registered surface exceeds the budget: deferred tools
   * (all MCP + demoted built-ins) activate only via load/preload. False =
   * hybrid bypass — everything fits, so everything is active (small
   * workspaces keep the zero-friction behavior).
   */
  pagingActive: boolean;
  /** Binding tool-count limit (soft budget ∧ provider hard cap). */
  maxActiveTools: number;
  /** Token budget for definitions, applied to the evictable tail only. */
  maxActiveToolTokens?: number;
  /** Estimated definition tokens per tool name (from the full ToolSet). */
  tokenWeights?: Map<string, number>;
  /** Deterministic per-turn relevance preload (deferred names). */
  preloadedToolNames?: string[];
}

const DEFAULT_WORKING_SET: WorkingSetOptions = {
  pagingActive: false,
  maxActiveTools: MAX_ACTIVE_TOOLS,
};

/**
 * Compute the active tool allowlist for the current step from the live
 * `ModeState`.
 *
 * Assembly order doubles as eviction priority (cut from the end, never the
 * base): core+mode tools, then — paging off — the full MCP set, then loaded
 * deferred tools newest-first, then the relevance preload. The plan hard
 * gate still applies: once a plan is submitted and unapproved, only
 * read-only + lifecycle tools survive, whatever tier they came from.
 */
export function computeActiveTools(
  modeState: ModeState,
  allToolNames: Set<string>,
  mcp?: { toolNames: string[]; readOnlyToolNames: string[] },
  options: WorkingSetOptions = DEFAULT_WORKING_SET,
): string[] {
  const base: string[] = [];
  const seen = new Set<string>();
  const push = (list: string[], name: string) => {
    if (!allToolNames.has(name) || seen.has(name)) return;
    seen.add(name);
    list.push(name);
  };

  for (const name of toolNamesForModes(modeState.enabledModes)) {
    push(base, name);
  }

  const evictable: string[] = [];
  if (!options.pagingActive) {
    // Hybrid bypass: the whole surface fits the budget. MCP tools stay
    // cross-cutting (their write gating is `needsApproval`, not modes) and
    // loaded/deferred names are honored too — this keeps behavior identical
    // for small workspaces while remaining trim-safe under a provider cap.
    for (const name of mcp?.toolNames ?? []) push(evictable, name);
  }
  // Loaded newest-first: the most recent load is the most relevant, so the
  // end-of-list cut evicts the oldest loads first (LRU).
  for (const name of [...modeState.loadedToolNames].reverse()) {
    push(evictable, name);
  }
  for (const name of options.preloadedToolNames ?? []) push(evictable, name);

  let names = [...base, ...evictable];

  if (isPlanGateActive(modeState)) {
    const mcpReadOnly = new Set(mcp?.readOnlyToolNames ?? []);
    names = names.filter(
      name =>
        READ_ONLY_TOOL_NAMES.has(name) ||
        mcpReadOnly.has(name) ||
        PLAN_GATE_ALLOWED_TOOL_NAMES.has(name),
    );
  }

  // Count budget: trim the evictable tail; base is never evicted (it is
  // bounded by the mode registry, far under every provider cap).
  if (names.length > options.maxActiveTools) {
    names = names.slice(0, Math.max(options.maxActiveTools, base.length));
  }

  // Token budget: applied to the tail as well, so one bloated connector
  // schema cannot crowd out the product's own tools.
  const { tokenWeights, maxActiveToolTokens } = options;
  if (tokenWeights && maxActiveToolTokens) {
    const kept: string[] = [];
    let tokens = 0;
    const baseSet = new Set(base);
    for (const name of names) {
      const weight = tokenWeights.get(name) ?? 0;
      if (baseSet.has(name) || tokens + weight <= maxActiveToolTokens) {
        kept.push(name);
        tokens += weight;
      }
    }
    names = kept;
  }

  return names;
}

export interface UnifiedModeRuntime {
  tools: ToolSet;
  modeState: ModeState;
  system: SystemModelMessage[];
  prepareStep: (options: {
    stepNumber: number;
  }) => { activeTools: string[]; system: SystemModelMessage[] } | undefined;
  /** Working-set telemetry for the request log. */
  workingSet: {
    pagingActive: boolean;
    totalRegisteredTools: number;
    maxActiveTools: number;
    activeToolCount: number;
    /** Estimated definition tokens of the initial active set. */
    activeToolTokens: number;
    preloadedToolNames: string[];
  };
}

/** Text of the latest user message — the input to the relevance preload. */
function lastUserMessageText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return ((message.parts ?? []) as UIMessagePart[])
      .map(part =>
        part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join(" ");
  }
  return "";
}

/**
 * Build the full tool union, derived mode state, tool catalog, initial
 * system, and the per-step `prepareStep` for the unified agent.
 */
export function buildUnifiedModeRuntime(params: {
  context: AgentContext;
  messages: UIMessage[];
  tabKind?: string;
  /** Gateway model id (e.g. "xai/grok-4.5") — drives the provider tool cap. */
  modelId?: string;
}): UnifiedModeRuntime {
  const { context, messages, tabKind, modelId } = params;

  const defaultMode = defaultExpertiseMode(context, tabKind);
  const modeState = deriveModeState(messages, defaultMode);

  // Reuse the unified agent factory for the domain tool objects, then add the
  // core lifecycle tools (server `enable_mode`/`todo_write` + the deferred
  // client plan tools).
  const { tools: domainTools } = unifiedAgentFactory(context);
  const modeTools = createModeTools(modeState);

  // Deferred-tool catalog: demoted built-ins (descriptions read from the
  // live tool objects) + every MCP tool (full descriptions from the DB
  // cache, via context). This is what search_tools ranks and what the
  // system-prompt inventory summarizes.
  const catalog: ToolCatalogEntry[] = [];
  for (const [name, domain] of Object.entries(DEFERRED_BUILTIN_TOOL_DOMAINS)) {
    const tool = (domainTools as ToolSet)[name];
    if (!tool) continue;
    catalog.push({
      name,
      source: { kind: "builtin", domain },
      description: tool.description ?? name,
      readOnly: READ_ONLY_TOOL_NAMES.has(name),
      tier: "deferred",
    });
  }
  for (const info of context.mcpToolCatalog ?? []) {
    catalog.push({
      name: info.name,
      source: {
        kind: "mcp",
        serverId: info.serverId,
        serverName: info.serverName,
      },
      description: info.description,
      readOnly: info.readOnly,
      tier: "deferred",
    });
  }

  const discoveryTools = createToolDiscoveryTools({ modeState, catalog });

  const tools: ToolSet = {
    ...domainTools,
    ...clientPlanTools,
    ...modeTools,
    ...discoveryTools,
  } as ToolSet;

  const allToolNames = new Set<string>(Object.keys(tools));
  const mcpAllowlist = {
    toolNames: context.mcpToolNames ?? [],
    readOnlyToolNames: context.mcpReadOnlyToolNames ?? [],
  };

  // Hybrid bypass: paging engages only when the registered surface cannot
  // fit the working-set budget for this model. Deterministic per request,
  // so resumed chats reconstruct the same behavior.
  const maxActiveTools = effectiveToolCountLimit(modelId);
  const pagingActive = allToolNames.size > maxActiveTools;
  const tokenWeights = estimateToolSetTokens(tools);
  const preloadedToolNames = pagingActive
    ? preloadToolNames(catalog, lastUserMessageText(messages))
    : [];

  const workingSetOptions: WorkingSetOptions = {
    pagingActive,
    maxActiveTools,
    maxActiveToolTokens: MAX_ACTIVE_TOOL_TOKENS,
    tokenWeights,
    preloadedToolNames,
  };

  // Always inject the name-only inventory (built-ins + MCP server list).
  // Schemas still come only from the active working set via the provider API.
  // Rebuild per step so enable_mode flips the "active" labels.
  const inventoryFor = () =>
    buildToolInventoryBlock(catalog, modeState.enabledModes);

  const prepareStep = () => ({
    activeTools: computeActiveTools(
      modeState,
      allToolNames,
      mcpAllowlist,
      workingSetOptions,
    ),
    system: buildModeSystem(context, modeState, inventoryFor()),
  });

  const initialActiveTools = computeActiveTools(
    modeState,
    allToolNames,
    mcpAllowlist,
    workingSetOptions,
  );

  return {
    tools,
    modeState,
    system: buildModeSystem(context, modeState, inventoryFor()),
    prepareStep,
    workingSet: {
      pagingActive,
      totalRegisteredTools: allToolNames.size,
      maxActiveTools,
      activeToolCount: initialActiveTools.length,
      activeToolTokens: initialActiveTools.reduce(
        (sum, name) => sum + (tokenWeights.get(name) ?? 0),
        0,
      ),
      preloadedToolNames,
    },
  };
}
