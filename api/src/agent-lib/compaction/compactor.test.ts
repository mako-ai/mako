import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  compactModelMessages,
  CLEAR_MARKER_PREFIX,
} from "./compactor";
import { resolveCompactionBudget, type CompactionConfig } from "./config";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

const config: CompactionConfig = {
  enabled: true,
  clearTriggerFraction: 0.6,
  summarizeTriggerFraction: 0.8,
  hardCeilingFraction: 0.92,
  keepRecentToolResults: 6,
  minClearDeltaChars: 4000,
  minResultClearChars: 1000,
};

// contextWindow 1000 -> clearTrigger 600, summarize 800, hardCeiling 920
const budget = resolveCompactionBudget(1000, config);

function bigValue(chars: number) {
  return { blob: "x".repeat(chars) };
}

function buildPairs(n: number, chars: number): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: "user", content: "start the task" }];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${i}`,
          toolName: "sql_execute_query",
          input: { i },
        },
      ],
    } as unknown as ModelMessage);
    msgs.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "sql_execute_query",
          output: { type: "json", value: bigValue(chars) },
        },
      ],
    } as unknown as ModelMessage);
  }
  return msgs;
}

function toolResultOutputs(messages: ModelMessage[]) {
  const out: Array<{ toolCallId: unknown; toolName: unknown; output: unknown }> =
    [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p && (p as { type?: unknown }).type === "tool-result") {
        out.push({
          toolCallId: (p as Record<string, unknown>).toolCallId,
          toolName: (p as Record<string, unknown>).toolName,
          output: (p as Record<string, unknown>).output,
        });
      }
    }
  }
  return out;
}

function countParts(messages: ModelMessage[], type: string): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p && (p as { type?: unknown }).type === type) n++;
    }
  }
  return n;
}

function isCleared(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "text" &&
    typeof (output as { value?: unknown }).value === "string" &&
    ((output as { value: string }).value).startsWith(CLEAR_MARKER_PREFIX)
  );
}

t("below clear trigger -> no-op, original reference returned", () => {
  const messages = buildPairs(10, 2000);
  const { messages: out, stats } = compactModelMessages(messages, {
    budget,
    config,
    currentTokens: 100,
  });
  assert.equal(stats.applied, false);
  assert.equal(stats.reason, "below-trigger");
  assert.equal(out, messages);
});

t("over trigger -> masks older results, keeps recent N verbatim", () => {
  const messages = buildPairs(10, 2000);
  const { messages: out, stats } = compactModelMessages(messages, {
    budget,
    config,
    currentTokens: 700, // > clearTrigger(600), < hardCeiling(920)
  });

  assert.equal(stats.applied, true);
  assert.equal(stats.toolResultsTotal, 10);
  // keepRecent=6 -> first 4 older results cleared
  assert.equal(stats.clearedCount, 4);
  assert.ok(stats.charsAfter < stats.charsBefore);

  // Pairing preserved: same number of tool-calls and tool-results.
  assert.equal(countParts(out, "tool-call"), 10);
  assert.equal(countParts(out, "tool-result"), 10);

  const outputs = toolResultOutputs(out);
  // First 4 cleared, keep toolCallId/toolName.
  for (let i = 0; i < 4; i++) {
    assert.ok(isCleared(outputs[i].output), `result ${i} should be cleared`);
    assert.equal(outputs[i].toolCallId, `call-${i}`);
    assert.equal(outputs[i].toolName, "sql_execute_query");
  }
  // Last 6 untouched (still json).
  for (let i = 4; i < 10; i++) {
    assert.equal((outputs[i].output as { type: string }).type, "json");
  }

  // Original not mutated.
  const origOutputs = toolResultOutputs(messages);
  assert.equal((origOutputs[0].output as { type: string }).type, "json");
});

t("idempotent: re-running does not clear again", () => {
  const messages = buildPairs(10, 2000);
  const first = compactModelMessages(messages, {
    budget,
    config,
    currentTokens: 700,
  });
  assert.equal(first.stats.applied, true);

  const second = compactModelMessages(first.messages, {
    budget,
    config,
    currentTokens: 700,
  });
  assert.equal(second.stats.applied, false);
  assert.equal(second.stats.clearedCount, 0);
  assert.equal(second.messages, first.messages);
});

t("respects minClearDelta: tiny savings are skipped", () => {
  // 7 pairs, keepRecent 6 -> only 1 candidate; ~1.2k chars saved < 4k delta.
  const messages = buildPairs(7, 1200);
  const { stats } = compactModelMessages(messages, {
    budget,
    config,
    currentTokens: 700,
  });
  assert.equal(stats.applied, false);
  assert.equal(stats.reason, "below-min-delta");
});

t("disabled config is a no-op", () => {
  const messages = buildPairs(10, 2000);
  const { messages: out, stats } = compactModelMessages(messages, {
    budget,
    config: { ...config, enabled: false },
    currentTokens: 999,
  });
  assert.equal(stats.applied, false);
  assert.equal(stats.reason, "disabled");
  assert.equal(out, messages);
});

t("aggressive past hard ceiling: keeps only 2 recent, ignores guards", () => {
  // Small results (below minResultClearChars) + few pairs: only cleared when
  // aggressive thresholds drop the guards to zero.
  const messages = buildPairs(5, 300);
  const { out: _omit, stats } = (() => {
    const r = compactModelMessages(messages, {
      budget,
      config,
      currentTokens: 950, // > hardCeiling(920)
    });
    return { out: r.messages, stats: r.stats };
  })();
  assert.equal(stats.applied, true);
  assert.equal(stats.reason, "cleared-aggressive");
  // keep 2 of 5 -> 3 cleared, even though each is < minResultClearChars.
  assert.equal(stats.clearedCount, 3);
});

t("non-aggressive leaves small results alone (cheap to keep)", () => {
  const messages = buildPairs(10, 300); // each result < minResultClearChars
  const { stats } = compactModelMessages(messages, {
    budget,
    config,
    currentTokens: 700,
  });
  assert.equal(stats.applied, false);
  assert.equal(stats.reason, "nothing-to-clear");
});
