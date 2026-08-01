import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { AcpBridgeEvent } from "./acp-types";
import {
  extractResumeTail,
  finalizeResumedParts,
  lastAssistantLooksIncomplete,
  lastUserMessageText,
  partsHaveContent,
  rebuildAssistantParts,
} from "./resume-local-acp-chat";
import { INTERRUPTED_TOOL_TEXT } from "../components/chat/convert-stored-messages";

const AT = "2026-08-01T10:00:00.000Z";

function userChunk(text: string): AcpBridgeEvent {
  return {
    type: "session_update",
    sessionId: "s1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    },
    at: AT,
  };
}

function agentChunk(text: string, phase?: string): AcpBridgeEvent {
  return {
    type: "session_update",
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      ...(phase ? { _meta: { codex: { phase } } } : {}),
    },
    at: AT,
  };
}

function thoughtChunk(text: string): AcpBridgeEvent {
  return {
    type: "session_update",
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
    at: AT,
  };
}

function toolCall(
  toolCallId: string,
  status: string,
  extra?: Record<string, unknown>,
): AcpBridgeEvent {
  return {
    type: "session_update",
    sessionId: "s1",
    update: {
      sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
      toolCallId,
      name: "sql_execute_query",
      status,
      ...extra,
    },
    at: AT,
  };
}

function turnDone(): AcpBridgeEvent {
  return { type: "turn_done", sessionId: "s1", stopReason: "end_turn", at: AT };
}

function msg(role: string, parts: Array<Record<string, unknown>>): UIMessage {
  return { id: `${role}-${Math.random()}`, role, parts } as UIMessage;
}

describe("extractResumeTail", () => {
  it("returns unmatched when the backlog has no user prompt", () => {
    const tail = extractResumeTail([agentChunk("hi")], "hello");
    expect(tail.matched).toBe(false);
    expect(tail.events).toHaveLength(0);
  });

  it("slices to the newest turn and matches the layered prompt suffix", () => {
    const events = [
      userChunk("old question"),
      agentChunk("old answer"),
      turnDone(),
      userChunk("[UI context]\nstuff\n\n[User message]\nnew question"),
      thoughtChunk("thinking"),
    ];
    const tail = extractResumeTail(events, "new question");
    expect(tail.matched).toBe(true);
    expect(tail.done).toBe(false);
    expect(tail.events).toHaveLength(1);
  });

  it("detects a finished turn via turn_done in the tail", () => {
    const events = [userChunk("q"), agentChunk("a"), turnDone()];
    const tail = extractResumeTail(events, "q");
    expect(tail.matched).toBe(true);
    expect(tail.done).toBe(true);
  });

  it("refuses another chat's turn (prompt does not end with our text)", () => {
    const events = [userChunk("different chat prompt"), agentChunk("a")];
    const tail = extractResumeTail(events, "our last user message");
    expect(tail.matched).toBe(false);
  });
});

describe("rebuildAssistantParts", () => {
  it("rebuilds reasoning, text, and tool parts from replayed events", () => {
    const parts = rebuildAssistantParts(
      [
        thoughtChunk("Let me check."),
        toolCall("t1", "pending", { rawInput: { query: "select 1" } }),
        toolCall("t1", "completed", { rawOutput: { rowCount: 1 } }),
        agentChunk("Here are the results."),
        turnDone(),
        agentChunk("chunk after done must be ignored"),
      ],
      "claude",
    );
    expect(parts.map(p => p.type)).toEqual([
      "reasoning",
      "dynamic-tool",
      "text",
    ]);
    const tool = parts[1] as { state?: string; toolCallId?: string };
    expect(tool.toolCallId).toBe("t1");
    expect(tool.state).toBe("output-available");
    expect((parts[2] as { text?: string }).text).toBe("Here are the results.");
  });

  it("routes Codex commentary-phase message chunks into reasoning", () => {
    const parts = rebuildAssistantParts(
      [agentChunk("planning…", "commentary"), agentChunk("final answer")],
      "codex",
    );
    expect(parts.map(p => p.type)).toEqual(["reasoning", "text"]);
  });
});

describe("lastAssistantLooksIncomplete", () => {
  it("is true when the newest message is an unanswered user turn", () => {
    expect(
      lastAssistantLooksIncomplete([
        msg("user", [{ type: "text", text: "q" }]),
      ]),
    ).toBe(true);
  });

  it("is true for streaming reasoning / pending or poisoned tool parts", () => {
    expect(
      lastAssistantLooksIncomplete([
        msg("assistant", [{ type: "reasoning", text: "", state: "streaming" }]),
      ]),
    ).toBe(true);
    expect(
      lastAssistantLooksIncomplete([
        msg("assistant", [
          { type: "dynamic-tool", toolCallId: "t", state: "output-streaming" },
        ]),
      ]),
    ).toBe(true);
    expect(
      lastAssistantLooksIncomplete([
        msg("assistant", [
          {
            type: "dynamic-tool",
            toolCallId: "t",
            state: "output-error",
            errorText: INTERRUPTED_TOOL_TEXT,
          },
        ]),
      ]),
    ).toBe(true);
  });

  it("is false for a settled assistant reply", () => {
    expect(
      lastAssistantLooksIncomplete([
        msg("assistant", [
          { type: "reasoning", text: "thought", state: "done" },
          { type: "text", text: "answer" },
        ]),
      ]),
    ).toBe(false);
  });
});

describe("finalizeResumedParts / partsHaveContent", () => {
  it("drops empty reasoning placeholders and falls back when empty", () => {
    const finalized = finalizeResumedParts([
      { type: "reasoning", text: "", state: "streaming" },
    ]);
    expect(finalized).toEqual([
      { type: "text", text: "(No response from local agent)" },
    ]);
  });

  it("marks streaming reasoning done and keeps real content", () => {
    const finalized = finalizeResumedParts([
      { type: "reasoning", text: "thinking", state: "streaming" },
      { type: "text", text: "answer" },
    ]);
    expect(finalized).toEqual([
      { type: "reasoning", text: "thinking", state: "done" },
      { type: "text", text: "answer" },
    ]);
    expect(partsHaveContent(finalized)).toBe(true);
  });
});

describe("lastUserMessageText", () => {
  it("reads the newest user message's text parts", () => {
    expect(
      lastUserMessageText([
        msg("user", [{ type: "text", text: "first" }]),
        msg("assistant", [{ type: "text", text: "reply" }]),
        msg("user", [
          { type: "file", url: "data:..." },
          { type: "text", text: " second " },
        ]),
      ]),
    ).toBe("second");
  });
});
