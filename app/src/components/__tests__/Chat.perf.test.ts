/**
 * Chat Performance Regression Tests
 *
 * These tests verify the memoization contracts that keep the Chat panel
 * responsive during AI streaming. If any of these fail, the Chat component
 * will re-render excessively and the UI will become unresponsive.
 *
 * See: .cursor/rules/75-chat-performance.mdc
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chatMessageRowArePropsEqual } from "../chat-message-comparator";
import { StreamingMarkdown } from "../StreamingMarkdown";
import { StreamingToolCard } from "../StreamingToolCard";

// ── Helpers ──────────────────────────────────────────────────

function makeProps(
  overrides: Partial<Parameters<typeof chatMessageRowArePropsEqual>[0]> = {},
): Parameters<typeof chatMessageRowArePropsEqual>[0] {
  return {
    message: {
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello world" }],
    },
    isLastMessage: false,
    isStreaming: false,
    onToolClick: () => {},
    paletteMode: "light",
    ...overrides,
  };
}

// ── React.memo wrapper checks ───────────────────────────────

describe("React.memo wrappers", () => {
  it("StreamingMarkdown is wrapped in React.memo", () => {
    // React.memo sets $$typeof to Symbol.for('react.memo')
    expect((StreamingMarkdown as any).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("StreamingToolCard is wrapped in React.memo", () => {
    expect((StreamingToolCard as any).$$typeof).toBe(Symbol.for("react.memo"));
  });
});

// ── ChatMessageRow comparator ───────────────────────────────

describe("chatMessageRowArePropsEqual", () => {
  it("returns true for identical props (reference equal message)", () => {
    const props = makeProps();
    expect(chatMessageRowArePropsEqual(props, props)).toBe(true);
  });

  it("returns true when message parts haven't changed (same content, different reference)", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("returns false when isLastMessage changes", () => {
    const prev = makeProps({ isLastMessage: false });
    const next = makeProps({ isLastMessage: true });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when isStreaming changes", () => {
    const prev = makeProps({ isStreaming: false });
    const next = makeProps({ isStreaming: true });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when paletteMode changes (theme toggle)", () => {
    const prev = makeProps({ paletteMode: "light" });
    const next = makeProps({ paletteMode: "dark" });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when text length changes (streaming token arrives)", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hel" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when part count changes (new part added)", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [
          { type: "text", text: "Hello" },
          { type: "tool-run_console", state: "input-streaming" },
        ],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when a tool part is input-streaming", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "input-streaming" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "input-streaming" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when a tool part is output-streaming", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "output-streaming" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "output-streaming" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns true when a tool part state is output-available (settled)", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_console",
            state: "output-available",
            input: { query: "SELECT 1" },
            output: { success: true },
          },
        ],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_console",
            state: "output-available",
            input: { query: "SELECT 1" },
            output: { success: true },
          },
        ],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("returns false when tool part state transitions", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "input-available" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-run_console", state: "output-available" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns true when reasoning text length is unchanged", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think..." }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think..." }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("returns false when reasoning text grows (streaming)", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think about this..." }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("skips re-render for completed messages when another message streams", () => {
    // This is the key regression scenario: a completed user message should NOT
    // re-render when the assistant message below it is streaming.
    const prev = makeProps({
      message: {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What tables exist?" }],
      },
      isLastMessage: false,
      isStreaming: true,
    });
    const next = makeProps({
      message: {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What tables exist?" }],
      },
      isLastMessage: false,
      isStreaming: true,
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("returns true when onToolClick reference changes (not compared)", () => {
    const prev = makeProps({ onToolClick: () => {} });
    const next = makeProps({ onToolClick: () => {} });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("returns false when text content changes but length stays the same", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "AAAA" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "BBBB" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when reasoning content changes but length stays the same", () => {
    const prev = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Plan A" }],
      },
    });
    const next = makeProps({
      message: {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Plan B" }],
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });
});

// ── Structural regression guards ─────────────────────────────
// These tests read the Chat.tsx source and verify critical patterns
// are present, catching regressions that slip past runtime tests.

describe("Chat.tsx structural guards", () => {
  const chatSource = fs.readFileSync(
    path.resolve(__dirname, "../Chat.tsx"),
    "utf-8",
  );

  it("useChat has experimental_throttle configured", () => {
    expect(chatSource).toMatch(/experimental_throttle\s*:\s*\d+/);
  });

  it("uses use-stick-to-bottom for scroll management", () => {
    expect(chatSource).toContain("useStickToBottom");
  });

  it("does NOT have a DIY useEffect([messages]) auto-scroll", () => {
    // The old pattern: useEffect depending on messages that calls scrollIntoView
    const diyScrollPattern =
      /useEffect\(\s*\(\)\s*=>\s*\{[^}]*scrollIntoView[^}]*\}\s*,\s*\[messages\]\)/s;
    expect(chatSource).not.toMatch(diyScrollPattern);
  });

  it("does NOT have isNearBottomRef (old DIY scroll state)", () => {
    expect(chatSource).not.toContain("isNearBottomRef");
  });

  it("does NOT have rafIdRef (old DIY scroll coalescing)", () => {
    expect(chatSource).not.toContain("rafIdRef");
  });
});
