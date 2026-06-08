/**
 * Integration test: real AI SDK `convertToModelMessages` -> compactor pipeline.
 *
 * Proves the masking transform produces ModelMessages that still pass the AI
 * SDK's own `modelMessageSchema` (i.e. remain valid for providers and for
 * `convertToModelMessages`), with tool-call/result pairing preserved.
 */
import assert from "node:assert/strict";
import {
  convertToModelMessages,
  modelMessageSchema,
  type UIMessage,
} from "ai";
import { compactModelMessages, CLEAR_MARKER_PREFIX } from "./compactor";
import { resolveCompactionBudget, type CompactionConfig } from "./config";

function t(label: string, fn: () => Promise<void> | void) {
  return Promise.resolve(fn()).then(() => {
    process.stdout.write(`ok  ${label}\n`);
  });
}

const config: CompactionConfig = {
  enabled: true,
  clearTriggerFraction: 0.6,
  summarizeTriggerFraction: 0.8,
  hardCeilingFraction: 0.92,
  keepRecentToolResults: 2,
  minClearDeltaChars: 1000,
  minResultClearChars: 500,
};
const budget = resolveCompactionBudget(1000, config);

function buildUIMessages(pairs: number, blobChars: number): UIMessage[] {
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "run analysis" }] },
  ];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [
        {
          type: "tool-sql_execute_query",
          toolCallId: `call-${i}`,
          state: "output-available",
          input: { query: `SELECT ${i}` },
          output: { rows: "x".repeat(blobChars) },
        },
      ],
    } as unknown as UIMessage);
  }
  messages.push({
    id: "final",
    role: "assistant",
    parts: [{ type: "text", text: "done" }],
  });
  return messages;
}

async function run() {
  await t(
    "convertToModelMessages -> compact -> still schema-valid + paired",
    async () => {
      const ui = buildUIMessages(6, 2000);
      const modelMessages = await convertToModelMessages(ui);

      const { messages: out, stats } = compactModelMessages(modelMessages, {
        budget,
        config,
        currentTokens: 700,
      });

      assert.equal(stats.applied, true);
      assert.ok(stats.clearedCount >= 1, "should clear at least one result");
      assert.ok(stats.charsAfter < stats.charsBefore);

      // Every resulting message must validate against the AI SDK schema.
      for (const m of out) {
        const parsed = modelMessageSchema.safeParse(m);
        assert.ok(
          parsed.success,
          `message not schema-valid: ${JSON.stringify(parsed.success ? {} : parsed.error.issues)}`,
        );
      }

      // Pairing invariant: every tool-call has a matching tool-result id.
      const callIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const m of out) {
        const content = (m as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const p of content) {
          const part = p as Record<string, unknown>;
          if (part.type === "tool-call") {
            callIds.add(String(part.toolCallId));
          }
          if (part.type === "tool-result") {
            resultIds.add(String(part.toolCallId));
          }
        }
      }
      assert.equal(callIds.size, resultIds.size);
      for (const id of callIds) {
        assert.ok(resultIds.has(id), `missing result for ${id}`);
      }

      // At least one masked placeholder is present.
      const hasPlaceholder = out.some(m => {
        const content = (m as { content?: unknown }).content;
        if (!Array.isArray(content)) return false;
        return content.some(p => {
          const part = p as Record<string, unknown>;
          const output = part.output as { type?: string; value?: unknown };
          return (
            part.type === "tool-result" &&
            output?.type === "text" &&
            typeof output.value === "string" &&
            output.value.startsWith(CLEAR_MARKER_PREFIX)
          );
        });
      });
      assert.ok(hasPlaceholder, "expected at least one cleared placeholder");
    },
  );
}

run().catch((err: unknown) => {
  const e = err as { stack?: string };
  process.stderr.write(String(e?.stack ?? err) + "\n");
  process.exitCode = 1;
});
