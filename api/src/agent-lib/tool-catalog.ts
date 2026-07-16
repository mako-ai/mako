/**
 * Tool catalog + working-set budgets for the unified agent.
 *
 * The provider request carries a bounded *working set* of tools; everything
 * else stays registered (executable, approval flow intact) but dormant —
 * discoverable via `search_tools` and activated via `load_tools`. This module
 * owns the pieces that make that budgeted:
 *
 *  - catalog entries (name + descriptions + tier) for deferred tools, so
 *    search has something to rank without shipping schemas to the model
 *  - token-weight estimation for tool definitions (schema + description)
 *  - the working-set budgets and per-provider hard caps that
 *    `computeActiveTools` enforces
 *
 * Tier semantics: "core" is always active, "mode" activates with an expertise
 * mode (see `modes/registry.ts`), "deferred" activates only via `load_tools`
 * (or the per-turn relevance preload).
 */

import { z } from "zod";
import type { ToolSet } from "ai";

export type ToolTier = "core" | "mode" | "deferred";

export interface ToolCatalogEntry {
  /** Provider-facing tool name (prefixed for MCP tools). */
  name: string;
  source:
    | { kind: "builtin"; domain: string }
    | { kind: "mcp"; serverId: string; serverName: string };
  /**
   * Full description used for search ranking. For MCP tools this is the
   * untruncated upstream description (the provider-facing one is dieted).
   */
  description: string;
  readOnly: boolean;
  tier: ToolTier;
}

/**
 * Working-set budgets. `MAX_ACTIVE_TOOLS` keeps the count under every
 * provider's limit with headroom (OpenAI caps at 128, xAI at 250);
 * `MAX_ACTIVE_TOOL_TOKENS` keeps the definitions' context cost bounded even
 * when individual schemas are heavy. Whichever binds first wins; loaded
 * deferred tools are evicted oldest-first, never core/mode tools.
 */
export const MAX_ACTIVE_TOOLS = 110;
export const MAX_ACTIVE_TOOL_TOKENS = 12_000;

/**
 * Hard per-provider tool-count caps enforced by the AI gateway. Exceeding
 * them is a request-rejecting 400 (e.g. "447 tools have been provided but
 * the maximum is 250" from xAI), so these are backstops applied after the
 * soft budget — deferred tools are trimmed first, with a warning log.
 */
const PROVIDER_TOOL_CAPS: Array<{ prefix: string; cap: number }> = [
  { prefix: "xai/", cap: 250 },
  { prefix: "openai/", cap: 128 },
];

export function providerToolCap(modelId: string | undefined): number | null {
  if (!modelId) return null;
  const match = PROVIDER_TOOL_CAPS.find(entry =>
    modelId.startsWith(entry.prefix),
  );
  return match ? match.cap : null;
}

/** The binding tool-count limit for a model: soft budget ∧ provider cap. */
export function effectiveToolCountLimit(modelId: string | undefined): number {
  const cap = providerToolCap(modelId);
  return cap === null ? MAX_ACTIVE_TOOLS : Math.min(MAX_ACTIVE_TOOLS, cap);
}

/** ~4 chars/token — the standard cheap estimate; we only need relative weight. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fallback weight when a tool's schema can't be serialized (opaque zod). */
const DEFAULT_SCHEMA_TOKENS = 120;

/**
 * Estimate the context cost (tokens) of one tool definition as the provider
 * sees it: name + description + JSON-schema of the input. Zod schemas are
 * converted via zod v4's native `toJSONSchema`; anything unserializable falls
 * back to a flat constant — estimates drive budgets and reporting, not
 * correctness.
 */
export function estimateToolDefinitionTokens(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
}): number {
  let schemaTokens = DEFAULT_SCHEMA_TOKENS;
  const schema = tool.inputSchema as
    | { jsonSchema?: unknown }
    | z.ZodType
    | undefined;
  try {
    if (schema && typeof schema === "object" && "jsonSchema" in schema) {
      // AI SDK `jsonSchema()` wrapper (dynamicTool / MCP tools).
      schemaTokens = estimateTokens(JSON.stringify(schema.jsonSchema ?? {}));
    } else if (schema instanceof z.ZodType) {
      schemaTokens = estimateTokens(JSON.stringify(z.toJSONSchema(schema)));
    }
  } catch {
    // Keep the fallback estimate.
  }
  return (
    estimateTokens(tool.name) +
    estimateTokens(tool.description ?? "") +
    schemaTokens
  );
}

/** Token weight per tool name for a full ToolSet (memoize per request). */
export function estimateToolSetTokens(tools: ToolSet): Map<string, number> {
  const weights = new Map<string, number>();
  for (const [name, tool] of Object.entries(tools)) {
    weights.set(
      name,
      estimateToolDefinitionTokens({
        name,
        description: tool.description,
        inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
      }),
    );
  }
  return weights;
}

/** One search hit: a compact "tool card" — deliberately schema-free. */
export interface ToolSearchHit {
  name: string;
  description: string;
  source: string;
  readOnly: boolean;
  score: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "tool",
  "tools",
  "with",
]);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 1 && !STOP_WORDS.has(term));
}

/**
 * Lexical relevance scoring over catalog entries. Deterministic and
 * dependency-free by design: the same ranking must be reproducible when a
 * chat is resumed (the per-turn preload relies on that). Name matches
 * outweigh description matches; server-name matches catch "slack" style
 * queries whose terms never appear in individual tool descriptions.
 */
export function scoreCatalogEntry(
  entry: ToolCatalogEntry,
  terms: string[],
): number {
  if (terms.length === 0) return 0;
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const serverName =
    entry.source.kind === "mcp" ? entry.source.serverName.toLowerCase() : "";

  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (serverName.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export function searchToolCatalog(
  catalog: ToolCatalogEntry[],
  query: string,
  limit = 10,
): ToolSearchHit[] {
  const terms = queryTerms(query);
  return catalog
    .map(entry => ({ entry, score: scoreCatalogEntry(entry, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, limit)
    .map(({ entry, score }) => ({
      name: entry.name,
      description:
        entry.description.length > 160
          ? `${entry.description.slice(0, 157)}…`
          : entry.description,
      source:
        entry.source.kind === "mcp"
          ? `${entry.source.serverName} (MCP)`
          : entry.source.domain,
      readOnly: entry.readOnly,
      score,
    }));
}

/**
 * Deterministic per-turn preload: the deferred tools most relevant to the
 * user's latest message. Recomputed from the message on every turn (both on
 * live requests and on stateless resume), so nothing needs to be persisted.
 * The minimum score keeps generic messages from dragging in random tools.
 */
const PRELOAD_MIN_SCORE = 3;

export function preloadToolNames(
  catalog: ToolCatalogEntry[],
  lastUserText: string,
  limit = 5,
): string[] {
  if (!lastUserText.trim()) return [];
  const terms = queryTerms(lastUserText);
  return catalog
    .filter(entry => entry.tier === "deferred")
    .map(entry => ({ entry, score: scoreCatalogEntry(entry, terms) }))
    .filter(({ score }) => score >= PRELOAD_MIN_SCORE)
    .sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
    )
    .slice(0, limit)
    .map(({ entry }) => entry.name);
}
