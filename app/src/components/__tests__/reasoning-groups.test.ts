/**
 * Regression tests for assistant "thinking" (reasoning) block grouping.
 *
 * Bug being guarded against: when the assistant starts a NEW thinking block
 * after intervening tool/text parts, the previously collapsed thinking block
 * would re-expand. The first streamed chunk of the new block arrives with empty
 * text; the old grouping only created a group for reasoning parts that already
 * had text, so the empty trailing part formed no group. That left the "last
 * group start" pointing at the OLD block, and because the message's last part
 * was a reasoning part, the old block was flagged as streaming and re-expanded.
 */
import { describe, it, expect } from "vitest";
import {
  computeReasoningGroups,
  getLastReasoningGroupStart,
} from "../reasoning-groups";

type Part = Record<string, unknown>;

// Mirrors the streaming-group selection in ChatMessageRow: only the most
// recent reasoning group is flagged as streaming when the message's last part
// is a reasoning part.
function streamingGroupStart(parts: Part[]): number {
  const groups = computeReasoningGroups(parts);
  const lastPart = parts.at(-1);
  const isLastPartReasoning = lastPart?.type === "reasoning";
  if (!isLastPartReasoning) return -1;
  return getLastReasoningGroupStart(groups);
}

describe("computeReasoningGroups", () => {
  it("merges consecutive reasoning parts into one block", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "first" },
      { type: "reasoning", text: "second" },
    ];
    const groups = computeReasoningGroups(parts);
    expect(groups.size).toBe(1);
    expect(groups.get(0)).toEqual({ text: "first\n\nsecond", lastIndex: 1 });
  });

  it("splits reasoning blocks separated by a tool/text part", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "block A" },
      { type: "tool-run_console", state: "output-available" },
      { type: "text", text: "Here is the answer" },
      { type: "reasoning", text: "block B" },
    ];
    const groups = computeReasoningGroups(parts);
    expect([...groups.keys()]).toEqual([0, 3]);
    expect(groups.get(0)?.text).toBe("block A");
    expect(groups.get(3)?.text).toBe("block B");
  });

  it("creates a group for a just-started empty reasoning part", () => {
    // The new block's first chunk has no text yet.
    const parts: Part[] = [
      { type: "reasoning", text: "block A" },
      { type: "tool-run_console", state: "output-available" },
      { type: "reasoning", text: "" },
    ];
    const groups = computeReasoningGroups(parts);
    expect([...groups.keys()]).toEqual([0, 2]);
    expect(groups.get(2)?.text).toBe("");
  });

  it("reads the `reasoning` field as well as `text` (history vs live)", () => {
    const parts: Part[] = [{ type: "reasoning", reasoning: "from history" }];
    const groups = computeReasoningGroups(parts);
    expect(groups.get(0)?.text).toBe("from history");
  });
});

describe("streaming group selection (re-expand regression)", () => {
  it("flags the NEW empty block as streaming, not the old collapsed one", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "done thinking about plan" },
      { type: "tool-run_console", state: "output-available" },
      { type: "text", text: "Running a query..." },
      { type: "reasoning", text: "" }, // new block just started, no text yet
    ];
    // The streaming flag must point at the new block (index 3), NOT the old
    // collapsed block (index 0).
    expect(streamingGroupStart(parts)).toBe(3);
  });

  it("keeps flagging the new block as it accrues text", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "done thinking about plan" },
      { type: "tool-run_console", state: "output-available" },
      { type: "text", text: "Running a query..." },
      { type: "reasoning", text: "now reconsidering" },
    ];
    expect(streamingGroupStart(parts)).toBe(3);
  });

  it("flags the only block while the first one is still streaming", () => {
    const parts: Part[] = [{ type: "reasoning", text: "thinking..." }];
    expect(streamingGroupStart(parts)).toBe(0);
  });

  it("flags no block when the last part is not reasoning", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "block A" },
      { type: "text", text: "final answer" },
    ];
    expect(streamingGroupStart(parts)).toBe(-1);
  });
});
