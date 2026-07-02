import { describe, it, expect } from "vitest";
import { convertStoredMessages } from "../convert-stored-messages";

const INTERRUPTED = "Interrupted — stream disconnected before tool completed";

describe("convertStoredMessages", () => {
  it("returns [] for null/undefined/empty input", () => {
    expect(convertStoredMessages(null)).toEqual([]);
    expect(convertStoredMessages(undefined)).toEqual([]);
    expect(convertStoredMessages([])).toEqual([]);
  });

  it("passes through text parts and preserves message id/role", () => {
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(msg.id).toBe("m1");
    expect(msg.role).toBe("user");
    expect(msg.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("falls back to _id and generates an id when both are missing", () => {
    const [withUnderscore, generated] = convertStoredMessages([
      { _id: "mongo-1", role: "user", parts: [{ type: "text", text: "a" }] },
      { role: "user", parts: [{ type: "text", text: "b" }] },
    ]);
    expect(withUnderscore.id).toBe("mongo-1");
    expect(typeof generated.id).toBe("string");
    expect(generated.id.length).toBeGreaterThan(0);
  });

  it("carries reasoning providerMetadata (Anthropic thinking signature)", () => {
    // Without the signature round-tripping, Anthropic rejects the next turn
    // with "thinking blocks ... cannot be modified".
    const meta = { anthropic: { signature: "sig-abc" } };
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "reasoning", reasoning: "thought A", providerMetadata: meta },
          { type: "reasoning", text: "thought B" },
        ],
      },
    ]);
    expect(msg.parts[0]).toEqual({
      type: "reasoning",
      text: "thought A",
      providerMetadata: meta,
    });
    // No providerMetadata key at all when the stored part had none.
    expect(msg.parts[1]).toEqual({ type: "reasoning", text: "thought B" });
  });

  it('rewrites legacy "error" tool state to output-error with errorText fallback chain', () => {
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_console",
            toolCallId: "c1",
            state: "error",
            errorText: "explicit text",
            output: { error: "output error" },
          },
          {
            type: "tool-run_console",
            toolCallId: "c2",
            state: "error",
            output: { error: "output error" },
          },
          {
            type: "tool-run_console",
            toolCallId: "c3",
            state: "error",
            output: { error: 42 },
          },
          { type: "tool-run_console", toolCallId: "c4", state: "error" },
        ],
      },
    ]);
    const states = msg.parts.map(p => p.state);
    expect(states).toEqual(Array(4).fill("output-error"));
    expect(msg.parts.map(p => p.errorText)).toEqual([
      "explicit text",
      "output error",
      "42",
      "Tool failed",
    ]);
    // Output is cleared and input defaulted so the SDK/model input stays valid.
    expect(msg.parts[0].output).toBeUndefined();
    expect(msg.parts[3].input).toEqual({});
  });

  it("keeps terminal tool parts as-is (with input defaulted to {})", () => {
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-create_dashboard",
            toolCallId: "c1",
            state: "output-available",
            output: { success: true },
          },
        ],
      },
    ]);
    expect(msg.parts[0].state).toBe("output-available");
    expect(msg.parts[0].input).toEqual({});
    expect(msg.parts[0].output).toEqual({ success: true });
  });

  it("patches interrupted (non-terminal) tool parts to output-error", () => {
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-create_data_source",
            toolCallId: "c1",
            state: "input-available",
            input: { name: "x" },
          },
          {
            type: "dynamic-tool",
            toolName: "custom_tool",
            toolCallId: "c2",
            state: "input-streaming",
          },
        ],
      },
    ]);
    for (const part of msg.parts) {
      expect(part.state).toBe("output-error");
      expect(part.errorText).toBe(INTERRUPTED);
      expect(part.output).toBeUndefined();
    }
    expect(msg.parts[0].input).toEqual({ name: "x" });
  });

  it("leaves non-terminal tool parts PENDING while the turn is still active server-side", () => {
    // Mid-turn reload: persistence is per-segment and async, so a settled
    // client tool can still read input-available in the snapshot. Patching it
    // to "Interrupted" while activeStreamId is set poisoned settled tools and
    // the next send persisted the poison — leave pending; resume replay /
    // orphan rescue settles it.
    const [msg] = convertStoredMessages(
      [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-create_dashboard",
              toolCallId: "c1",
              state: "input-available",
              input: { title: "X" },
            },
          ],
        },
      ],
      { turnActive: true },
    );
    expect(msg.parts[0].state).toBe("input-available");
    expect(msg.parts[0].errorText).toBeUndefined();
  });

  it("keeps unanswered human-in-the-loop tools pending (interactive card must survive reload)", () => {
    const [msg] = convertStoredMessages([
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-ask_clarifying_questions",
            toolCallId: "c1",
            state: "input-available",
            input: { questions: [] },
          },
          {
            type: "tool-submit_plan",
            toolCallId: "c2",
            state: "input-available",
            input: { title: "Plan" },
          },
        ],
      },
    ]);
    for (const part of msg.parts) {
      expect(part.state).toBe("input-available");
      expect(part.errorText).toBeUndefined();
    }
  });

  it("passes through unknown part types untouched", () => {
    const part = { type: "step-start" };
    const [msg] = convertStoredMessages([
      { id: "m1", role: "assistant", parts: [part] },
    ]);
    expect(msg.parts[0]).toEqual(part);
  });

  it("reconstructs parts from legacy fields (toolCalls -> reasoning -> text)", () => {
    const [msg] = convertStoredMessages([
      {
        _id: "legacy-1",
        role: "assistant",
        content: "final answer",
        reasoning: ["thought 1", "thought 2"],
        toolCalls: [
          {
            toolName: "run_console",
            toolCallId: "tc1",
            input: { sql: "SELECT 1" },
            result: { rows: 1 },
          },
          // toolName missing -> skipped entirely
          { toolCallId: "tc2" },
        ],
      },
    ]);
    expect(msg.parts.map(p => p.type)).toEqual([
      "tool-run_console",
      "reasoning",
      "reasoning",
      "text",
    ]);
    expect(msg.parts[0]).toMatchObject({
      toolCallId: "tc1",
      toolName: "run_console",
      state: "output-available",
      input: { sql: "SELECT 1" },
      output: { rows: 1 },
    });
    expect(msg.parts[3]).toEqual({ type: "text", text: "final answer" });
  });

  it("legacy fallback generates a toolCallId when missing", () => {
    const [msg] = convertStoredMessages([
      {
        id: "legacy-2",
        role: "assistant",
        toolCalls: [{ toolName: "run_console" }],
      },
    ]);
    const id = msg.parts[0].toolCallId as string;
    expect(id.startsWith("saved-run_console-")).toBe(true);
  });
});
