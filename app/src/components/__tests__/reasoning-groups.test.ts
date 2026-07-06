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
  getStreamingReasoningGroupStart,
} from "../reasoning-groups";

type Part = Record<string, unknown>;

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

  it("bridges a reasoning run across a step-start marker", () => {
    // Multi-step tool loops (and resume replay) insert a step-start between
    // thinking segments; it must not split the block.
    const parts: Part[] = [
      { type: "reasoning", text: "part one" },
      { type: "step-start" },
      { type: "reasoning", text: "part two" },
    ];
    const groups = computeReasoningGroups(parts);
    expect([...groups.keys()]).toEqual([0]);
    expect(groups.get(0)).toEqual({
      text: "part one\n\npart two",
      lastIndex: 2,
    });
  });

  it("still splits reasoning across a tool part even after a step-start", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "block A" },
      { type: "step-start" },
      { type: "tool-run_console", state: "output-available" },
      { type: "reasoning", text: "block B" },
    ];
    const groups = computeReasoningGroups(parts);
    expect([...groups.keys()]).toEqual([0, 3]);
    expect(groups.get(0)?.text).toBe("block A");
    expect(groups.get(3)?.text).toBe("block B");
  });

  it("dedupes an exact duplicate reasoning part (replay artifact)", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "thinking hard" },
      { type: "reasoning", text: "thinking hard" },
    ];
    expect(computeReasoningGroups(parts).get(0)?.text).toBe("thinking hard");
  });

  it("collapses a partial copy into its extended copy (prefix-superset)", () => {
    // The classic symptom: a prematurely-collapsed partial block ("ABC")
    // followed by the replayed, still-streaming extended copy ("ABC more…").
    const parts: Part[] = [
      { type: "reasoning", text: "ABC" },
      { type: "step-start" },
      { type: "reasoning", text: "ABC more thinking" },
    ];
    expect(computeReasoningGroups(parts).get(0)?.text).toBe(
      "ABC more thinking",
    );
  });

  it("dedupes by Anthropic signature, keeping the longest copy", () => {
    const sigMeta = { anthropic: { signature: "sig-1" } };
    const parts: Part[] = [
      { type: "reasoning", text: "short", providerMetadata: sigMeta },
      {
        type: "reasoning",
        text: "short but longer",
        providerMetadata: sigMeta,
      },
    ];
    expect(computeReasoningGroups(parts).get(0)?.text).toBe("short but longer");
  });

  it("dedupes a signature-equal duplicate separated by tool/text parts", () => {
    // The dominant shape in production data: the SAME thinking block (same
    // Anthropic signature) persisted twice with real parts between the copies.
    const sigMeta = { anthropic: { signature: "sig-dup" } };
    const parts: Part[] = [
      { type: "reasoning", text: "same thinking", providerMetadata: sigMeta },
      { type: "text", text: "answer so far" },
      { type: "tool-read_console", state: "output-available" },
      { type: "step-start" },
      { type: "reasoning", text: "same thinking", providerMetadata: sigMeta },
    ];
    const groups = computeReasoningGroups(parts);
    expect([...groups.keys()]).toEqual([0, 4]);
    expect(groups.get(0)?.text).toBe("same thinking");
    // Later copy folded into the earlier block — its group renders nothing.
    expect(groups.get(4)?.text).toBe("");
  });

  it("dedupes an exact text duplicate separated by tool parts (no signatures)", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "repeated thought" },
      { type: "tool-dbt_get_run", state: "output-available" },
      { type: "reasoning", text: "repeated thought" },
    ];
    const groups = computeReasoningGroups(parts);
    expect(groups.get(0)?.text).toBe("repeated thought");
    expect(groups.get(2)?.text).toBe("");
  });

  it("folds a cross-run prefix-superset into the earlier block", () => {
    // Resume replay: partial copy cut mid-stream (no signature), then the
    // replayed full copy (signatured) lands after a tool call. The full text
    // must display ONCE, in the earlier block's position.
    const parts: Part[] = [
      { type: "reasoning", text: "ABC" },
      { type: "tool-run_console", state: "output-available" },
      {
        type: "reasoning",
        text: "ABC more thinking",
        providerMetadata: { anthropic: { signature: "sig-full" } },
      },
    ];
    const groups = computeReasoningGroups(parts);
    expect(groups.get(0)?.text).toBe("ABC more thinking");
    expect(groups.get(2)?.text).toBe("");
  });

  it("keeps genuinely different reasoning blocks across tool parts", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "planning the query" },
      { type: "tool-run_console", state: "output-available" },
      { type: "reasoning", text: "interpreting the results" },
    ];
    const groups = computeReasoningGroups(parts);
    expect(groups.get(0)?.text).toBe("planning the query");
    expect(groups.get(2)?.text).toBe("interpreting the results");
  });

  it("keeps distinct signatured blocks separate even if text overlaps", () => {
    const parts: Part[] = [
      {
        type: "reasoning",
        text: "Let me look",
        providerMetadata: { anthropic: { signature: "sig-a" } },
      },
      {
        type: "reasoning",
        text: "Let me look at the schema",
        providerMetadata: { anthropic: { signature: "sig-b" } },
      },
    ];
    expect(computeReasoningGroups(parts).get(0)?.text).toBe(
      "Let me look\n\nLet me look at the schema",
    );
  });
});

describe("getStreamingReasoningGroupStart (re-expand regression)", () => {
  it("flags the NEW empty block as streaming, not the old collapsed one", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "done thinking about plan" },
      { type: "tool-run_console", state: "output-available" },
      { type: "text", text: "Running a query..." },
      { type: "reasoning", text: "" }, // new block just started, no text yet
    ];
    // The streaming flag must point at the new block (index 3), NOT the old
    // collapsed block (index 0). This is the core re-expand bug: with the new
    // block's first chunk empty, the old block must stay collapsed AND the new
    // block must show its "Thinking…" indicator immediately.
    expect(getStreamingReasoningGroupStart(parts)).toBe(3);
  });

  it("keeps flagging the new block as it accrues text", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "done thinking about plan" },
      { type: "tool-run_console", state: "output-available" },
      { type: "text", text: "Running a query..." },
      { type: "reasoning", text: "now reconsidering" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBe(3);
  });

  it("keeps a contiguous reasoning group streaming through an empty trailing part", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "Still thinking" },
      { type: "reasoning", text: "" },
    ];
    const groups = computeReasoningGroups(parts);
    expect(groups.get(0)).toEqual({ text: "Still thinking", lastIndex: 1 });
    expect(getStreamingReasoningGroupStart(parts, groups)).toBe(0);
  });

  it("flags the only block while the first one is still streaming", () => {
    const parts: Part[] = [{ type: "reasoning", text: "thinking..." }];
    expect(getStreamingReasoningGroupStart(parts)).toBe(0);
  });

  it("flags no block when the last part is not reasoning", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "block A" },
      { type: "text", text: "final answer" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBeNull();
  });
});

describe("getStreamingReasoningGroupStart (state-driven)", () => {
  it("flags the last block while its trailing part is streaming", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "done block", state: "done" },
      { type: "tool-run_console", state: "output-available" },
      { type: "reasoning", text: "live block", state: "streaming" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBe(2);
  });

  it("flags no block once the last reasoning part is done", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "first", state: "done" },
      { type: "reasoning", text: "second", state: "done" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBeNull();
  });

  it("does not re-open an earlier block left streaming by a missing end", () => {
    // An earlier block never got its reasoning-end (stuck 'streaming'), but the
    // active block below it is done — nothing should be force-expanded.
    const parts: Part[] = [
      { type: "reasoning", text: "stale", state: "streaming" },
      { type: "text", text: "answer" },
      { type: "reasoning", text: "final", state: "done" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBeNull();
  });

  it("ignores a trailing step-start when reading the streaming state", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "live", state: "streaming" },
      { type: "step-start" },
    ];
    expect(getStreamingReasoningGroupStart(parts)).toBe(0);
  });
});
