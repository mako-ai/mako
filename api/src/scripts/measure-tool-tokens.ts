/**
 * Measure the context cost of every registered agent tool definition.
 *
 * Prints per-tool estimated tokens (name + description + JSON schema),
 * sorted heaviest-first, plus per-tier totals — the data behind working-set
 * budget tuning (see agent-lib/tool-catalog.ts). MCP tools are per-workspace
 * and not included here; their weights are logged per request instead.
 *
 * Run: pnpm --filter api tools:measure   (or: tsx src/scripts/measure-tool-tokens.ts)
 */
import { buildUnifiedModeRuntime } from "../agents/modes/runtime";
import {
  CORE_ALWAYS_TOOL_NAMES,
  DEFERRED_BUILTIN_TOOL_NAMES,
  EXPERTISE_MODE_IDS,
  modeRegistry,
  toolNamesForModes,
} from "../agents/modes/registry";
import { estimateToolSetTokens } from "../agent-lib/tool-catalog";
import type { AgentContext } from "../agents/types";

/* eslint-disable no-console */

const context = {
  workspaceId: "000000000000000000000000",
  userId: "measure",
  consoles: [],
  databases: [],
} as unknown as AgentContext;

const runtime = buildUnifiedModeRuntime({
  context,
  messages: [],
});

const weights = estimateToolSetTokens(runtime.tools);
const core = new Set(CORE_ALWAYS_TOOL_NAMES);
const deferred = new Set(DEFERRED_BUILTIN_TOOL_NAMES);

const tierOf = (name: string): string => {
  if (core.has(name)) return "core";
  if (deferred.has(name)) return "deferred";
  return "mode";
};

const rows = Array.from(weights.entries())
  .map(([name, tokens]) => ({ name, tokens, tier: tierOf(name) }))
  .sort((a, b) => b.tokens - a.tokens);

console.log("tool".padEnd(44), "tier".padEnd(10), "~tokens");
console.log("-".repeat(64));
for (const row of rows) {
  console.log(
    row.name.padEnd(44),
    row.tier.padEnd(10),
    String(row.tokens).padStart(7),
  );
}

const total = rows.reduce((sum, r) => sum + r.tokens, 0);
const byTier = new Map<string, number>();
for (const row of rows) {
  byTier.set(row.tier, (byTier.get(row.tier) ?? 0) + row.tokens);
}

console.log("-".repeat(64));
console.log(`total: ${rows.length} tools, ~${total} tokens`);
for (const [tier, tokens] of byTier) {
  console.log(`  ${tier}: ~${tokens} tokens`);
}

console.log("\nper-mode active-set estimate (core + mode tools):");
for (const modeId of EXPERTISE_MODE_IDS) {
  const names = toolNamesForModes(new Set([modeId]));
  let tokens = 0;
  let count = 0;
  for (const name of names) {
    const weight = weights.get(name);
    if (weight === undefined) continue;
    tokens += weight;
    count += 1;
  }
  console.log(
    `  ${modeRegistry[modeId].name.padEnd(12)} ${String(count).padStart(3)} tools  ~${tokens} tokens`,
  );
}

// The agent stack keeps the event loop alive (loggers, mongoose schemas).
// eslint-disable-next-line no-process-exit
process.exit(0);
