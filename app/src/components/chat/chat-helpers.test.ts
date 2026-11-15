import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  describeChatError,
  findPendingInteractiveTool,
  serializeChatHistory,
  settleDanglingToolParts,
} from "./chat-helpers";

const assistant = (parts: Array<Record<string, unknown>>): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as unknown as UIMessage;

describe("describeChatError", () => {
  it("routes billing errors to the upgrade prompt", () => {
    expect(
      describeChatError(
        JSON.stringify({
          code: "usage_limit_exceeded",
          message: "Out of credits",
          plan: "free",
          quotaUsd: 5,
        }),
      ),
    ).toEqual({
      kind: "upgrade",
      errorCode: "usage_limit_exceeded",
      message: "Out of credits",
      plan: "free",
      currentUsageUsd: undefined,
      quotaUsd: 5,
    });
  });

  it("unwraps structured messages and passes plain text through", () => {
    expect(
      describeChatError(
        JSON.stringify({ code: "rate_limit", message: "Slow" }),
      ),
    ).toEqual({ kind: "message", message: "Slow" });
    expect(describeChatError("boom")).toEqual({
      kind: "message",
      message: "boom",
    });
    expect(describeChatError('{"x":1}')).toEqual({
      kind: "message",
      message: '{"x":1}',
    });
  });
});

describe("findPendingInteractiveTool", () => {
  it("finds an unresolved clarifying question or plan", () => {
    expect(
      findPendingInteractiveTool(
        assistant([
          { type: "text", text: "hi" },
          {
            type: "tool-ask_clarifying_questions",
            toolCallId: "c1",
            state: "input-available",
            input: { q: 1 },
          },
        ]),
      ),
    ).toEqual({
      toolName: "ask_clarifying_questions",
      toolCallId: "c1",
      input: { q: 1 },
      streaming: false,
      viaAcpBridge: false,
    });
    expect(
      findPendingInteractiveTool(
        assistant([
          {
            type: "dynamic-tool",
            toolName: "submit_plan",
            toolCallId: "p1",
            state: "input-streaming",
          },
        ]),
      ),
    ).toMatchObject({ toolName: "submit_plan", streaming: true });
  });

  it("ignores resolved tools, streaming questions and user messages", () => {
    expect(
      findPendingInteractiveTool(
        assistant([
          { type: "tool-submit_plan", state: "output-available" },
          { type: "tool-ask_clarifying_questions", state: "input-streaming" },
        ]),
      ),
    ).toBeNull();
    expect(findPendingInteractiveTool({ role: "user", parts: [] })).toBeNull();
    expect(findPendingInteractiveTool(undefined)).toBeNull();
  });
});

describe("serializeChatHistory", () => {
  it("keeps text, reasoning and tool essentials", () => {
    expect(
      serializeChatHistory([
        assistant([
          { type: "text", text: "a" },
          { type: "reasoning", text: "r", providerMetadata: {} },
          {
            type: "tool-run_console",
            toolCallId: "t",
            state: "output-available",
            input: 1,
            output: 2,
            extra: true,
          },
          { type: "step-start" },
        ]),
      ]),
    ).toEqual([
      {
        id: "m1",
        role: "assistant",
        parts: [
          { type: "text", text: "a" },
          { type: "reasoning", text: "r" },
          {
            type: "tool-run_console",
            toolCallId: "t",
            toolName: "run_console",
            state: "output-available",
            input: 1,
            output: 2,
          },
          { type: "step-start" },
        ],
      },
    ]);
  });
});

describe("settleDanglingToolParts", () => {
  it("errors only unsettled tool parts and keeps settled messages", () => {
    const settled = assistant([{ type: "tool-x", state: "output-available" }]);
    const dangling = assistant([
      { type: "text", text: "t" },
      { type: "tool-y", state: "input-available" },
      { type: "tool-z", state: "error" },
    ]);
    const [a, b] = settleDanglingToolParts([settled, dangling]);
    expect(a).toBe(settled);
    expect(b.parts).toEqual([
      { type: "text", text: "t" },
      {
        type: "tool-y",
        state: "error",
        output: { success: false, error: "Tool cancelled (chat stopped)" },
      },
      { type: "tool-z", state: "error" },
    ]);
  });
});
