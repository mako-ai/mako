import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { elideOldToolOutputs, stripReplayedReasoning } from "./compaction";
import { estimateUiMessagesTokens } from "./token-estimate";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

// A big tool output that comfortably clears the elision token threshold.
function bigOutput(tag: string) {
  return {
    success: true,
    data: Array.from({ length: 200 }, (_, i) => ({
      id: i,
      tag,
      value: `row-${i}-${"x".repeat(40)}`,
    })),
  };
}

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistantWithTool(id: string, tag: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "Running a query." },
      {
        type: "tool-sql_execute_query",
        toolCallId: `call-${id}`,
        toolName: "sql_execute_query",
        input: { sql: `SELECT * FROM t_${tag}` },
        output: bigOutput(tag),
        state: "output-available",
      },
    ],
  } as UIMessage;
}

function isElided(msg: UIMessage): boolean {
  const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
  return parts.some(
    p =>
      (p as { output?: { _compacted?: boolean } }).output?._compacted === true,
  );
}

// Build a conversation of N turns; each turn = user msg + assistant w/ big tool.
function conversation(turns: number): UIMessage[] {
  const msgs: UIMessage[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push(userMsg(`u${i}`, `Question ${i}`));
    msgs.push(assistantWithTool(`a${i}`, String(i)));
  }
  return msgs;
}

// --- Tests ----------------------------------------------------------------

t("no-op when conversation is within the keep-recent window", () => {
  const msgs = conversation(2); // 2 turns, default keepRecentTurns=2
  const res = elideOldToolOutputs(msgs);
  assert.equal(res.changed, false);
  assert.equal(res.elidedCount, 0);
  assert.equal(res.messages, msgs); // same reference, untouched
});

t("elides large tool outputs in OLD turns, keeps recent turns verbatim", () => {
  const msgs = conversation(6); // turns 0..5; keep last 2 (turns 4,5)
  const res = elideOldToolOutputs(msgs);
  assert.equal(res.changed, true);
  // 4 old assistant turns each had 1 big tool output elided.
  assert.equal(res.elidedCount, 4);

  // messages are: [u0,a0, u1,a1, u2,a2, u3,a3, u4,a4, u5,a5]
  // recent window = last 2 turns => indices for u4,a4,u5,a5 (idx 8..11).
  const assistants = res.messages.filter(m => m.role === "assistant");
  // a0..a3 elided, a4,a5 verbatim
  assert.equal(isElided(assistants[0]), true, "a0 should be elided");
  assert.equal(isElided(assistants[3]), true, "a3 should be elided");
  assert.equal(isElided(assistants[4]), false, "a4 (recent) verbatim");
  assert.equal(isElided(assistants[5]), false, "a5 (recent) verbatim");
});

t("preserves tool call identity and input when eliding output", () => {
  const msgs = conversation(4);
  const res = elideOldToolOutputs(msgs);
  const a0 = res.messages.find(m => m.id === "a0");
  assert.ok(a0, "a0 message present");
  const toolPart = (a0.parts as Array<Record<string, unknown>>).find(p =>
    String(p.type).startsWith("tool-"),
  );
  assert.ok(toolPart, "tool part present");
  assert.equal(toolPart.toolCallId, "call-a0");
  assert.deepEqual(toolPart.input, { sql: "SELECT * FROM t_0" });
  assert.equal((toolPart.output as { _compacted?: boolean })._compacted, true);
});

t("significantly reduces estimated token count", () => {
  const msgs = conversation(10);
  const before = estimateUiMessagesTokens(msgs);
  const res = elideOldToolOutputs(msgs);
  const after = estimateUiMessagesTokens(res.messages);
  assert.ok(
    after < before * 0.5,
    `expected >50% reduction, got before=${before} after=${after}`,
  );
});

t("is idempotent (second pass elides nothing new)", () => {
  const msgs = conversation(6);
  const first = elideOldToolOutputs(msgs);
  const second = elideOldToolOutputs(first.messages);
  assert.equal(second.changed, false);
  assert.equal(second.elidedCount, 0);
});

t("leaves small tool outputs alone even in old turns", () => {
  const msgs: UIMessage[] = [
    userMsg("u0", "q0"),
    {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "tool-get_count",
          toolCallId: "c0",
          toolName: "get_count",
          input: {},
          output: { count: 3 },
          state: "output-available",
        },
      ],
    } as UIMessage,
    userMsg("u1", "q1"),
    assistantWithTool("a1", "1"),
    userMsg("u2", "q2"),
    assistantWithTool("a2", "2"),
  ];
  const res = elideOldToolOutputs(msgs);
  // a0's tiny output is below threshold → untouched even though it's old.
  const a0 = res.messages.find(m => m.id === "a0");
  assert.ok(a0, "a0 message present");
  assert.equal(isElided(a0), false);
});

t("respects custom keepRecentTurns and minTokens", () => {
  const msgs = conversation(5);
  const res = elideOldToolOutputs(msgs, { keepRecentTurns: 1 });
  // keep only the last turn => 4 old turns elided.
  assert.equal(res.elidedCount, 4);

  const none = elideOldToolOutputs(msgs, { minTokens: 10_000_000 });
  assert.equal(none.changed, false);
});

// --- stripReplayedReasoning ----------------------------------------------

function assistantWithReasoning(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "reasoning", text: `thinking about ${text}` },
      { type: "text", text },
    ],
  } as UIMessage;
}

function reasoningPartCount(msgs: UIMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    for (const p of (m.parts ?? []) as Array<Record<string, unknown>>) {
      if (p.type === "reasoning") n += 1;
    }
  }
  return n;
}

t("strips ALL reasoning when the last message is a fresh user turn", () => {
  const msgs: UIMessage[] = [
    userMsg("u0", "q0"),
    assistantWithReasoning("a0", "answer 0"),
    userMsg("u1", "q1"),
    assistantWithReasoning("a1", "answer 1"),
    userMsg("u2", "q2"), // fresh user turn → no continuation
  ];
  assert.equal(reasoningPartCount(msgs), 2);
  const res = stripReplayedReasoning(msgs);
  assert.equal(res.changed, true);
  assert.equal(res.strippedCount, 2);
  assert.equal(reasoningPartCount(res.messages), 0);
});

t("preserves reasoning on the last assistant msg during a continuation", () => {
  // Last message is an assistant message (e.g. a client tool result was folded
  // back into it) → Anthropic interleaved thinking may require its thinking.
  const msgs: UIMessage[] = [
    userMsg("u0", "q0"),
    assistantWithReasoning("a0", "answer 0"),
    userMsg("u1", "q1"),
    assistantWithReasoning("a1", "answer 1"), // last assistant, continuation
  ];
  const res = stripReplayedReasoning(msgs);
  assert.equal(res.changed, true);
  // a0 stripped, a1 preserved
  assert.equal(res.strippedCount, 1);
  const a1 = res.messages.find(m => m.id === "a1");
  assert.ok(a1);
  assert.equal(
    (a1.parts as Array<Record<string, unknown>>).some(
      p => p.type === "reasoning",
    ),
    true,
  );
  const a0 = res.messages.find(m => m.id === "a0");
  assert.ok(a0);
  assert.equal(
    (a0.parts as Array<Record<string, unknown>>).some(
      p => p.type === "reasoning",
    ),
    false,
  );
});

t("never empties a reasoning-only assistant message", () => {
  const msgs: UIMessage[] = [
    userMsg("u0", "q0"),
    {
      id: "a0",
      role: "assistant",
      parts: [{ type: "reasoning", text: "only thinking, no answer" }],
    } as UIMessage,
    userMsg("u1", "q1"),
  ];
  const res = stripReplayedReasoning(msgs);
  // Stripping would empty a0 → left untouched.
  assert.equal(res.changed, false);
  assert.equal(reasoningPartCount(res.messages), 1);
});

t("no-op when there is no reasoning to strip", () => {
  const msgs = conversation(3);
  const res = stripReplayedReasoning(msgs);
  assert.equal(res.changed, false);
  assert.equal(res.strippedCount, 0);
});

process.stdout.write("\nAll compaction tests passed.\n");
