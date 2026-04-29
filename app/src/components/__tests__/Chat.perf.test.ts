/**
 * Chat Performance Regression Tests
 *
 * These tests verify the memoization contracts that keep the Chat panel
 * responsive during AI streaming. If any of these fail, the Chat component
 * will re-render excessively AND/OR fail to re-render at all during streaming.
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

const stableNoop = () => {};
const stableConnectionIconById = new Map<string, string>();

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
    onToolClick: stableNoop,
    onConsoleTitleClick: stableNoop,
    connectionIconById: stableConnectionIconById,
    paletteMode: "light",
    ...overrides,
  };
}

// ── React.memo wrapper checks ───────────────────────────────

describe("React.memo wrappers", () => {
  it("StreamingMarkdown is wrapped in React.memo", () => {
    expect((StreamingMarkdown as any).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("StreamingToolCard is wrapped in React.memo", () => {
    expect((StreamingToolCard as any).$$typeof).toBe(Symbol.for("react.memo"));
  });
});

// ── ChatMessageRow comparator ───────────────────────────────
//
// Contract: reference equality on `message` (NOT deep content comparison).
//
// Why: the AI SDK's first chunk uses `pushMessage`, which stores the RAW
// mutable message reference in `messages[last]`. Later chunks call
// `replaceMessage` (structuredClone). React.memo's stored "prev" gets
// seeded with the RAW reference on the first render, and that reference
// keeps being mutated in place (`part.text += delta`). A content-based
// comparator would then see prev and next as identical (both reflect the
// latest state) and permanently skip rendering until `isStreaming` flips.
//
// Reference equality sidesteps the mutation problem: every `replaceMessage`
// produces a new reference, so the comparator correctly returns false.
// `experimental_throttle: 50` in useChat batches these updates to ~20/sec.

describe("chatMessageRowArePropsEqual", () => {
  it("returns true when all references are identical", () => {
    const props = makeProps();
    expect(chatMessageRowArePropsEqual(props, props)).toBe(true);
  });

  it("returns false when the message reference changes (streaming tick)", () => {
    // This is THE streaming re-render trigger. On every chunk, useChat
    // produces a new message reference via structuredClone; without this
    // re-render, streamed text would never appear until completion.
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
        parts: [{ type: "text", text: "Hello" }], // same content, new ref
      },
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
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

  it("returns false when onToolClick reference changes", () => {
    const prev = makeProps({ onToolClick: () => {} });
    const next = makeProps({ onToolClick: () => {} });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when onConsoleTitleClick reference changes", () => {
    const prev = makeProps({ onConsoleTitleClick: () => {} });
    const next = makeProps({ onConsoleTitleClick: () => {} });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("returns false when connectionIconById reference changes", () => {
    const prev = makeProps({ connectionIconById: new Map() });
    const next = makeProps({ connectionIconById: new Map() });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(false);
  });

  it("skips re-render when a completed user message keeps its ref across streaming ticks", () => {
    // The AI SDK's replaceMessage only clones messages[last]; earlier
    // messages retain their references across ticks. So completed messages
    // (e.g. the user prompt) correctly skip re-rendering while the assistant
    // streams below them.
    //
    // Chat.tsx uses `useCallback` to keep callbacks stable across renders,
    // which is what makes this skip safe — all other prop references match too.
    const sharedUserMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "What tables exist?" }],
    };
    const stableOnToolClick = () => {};
    const stableOnConsoleTitleClick = () => {};
    const stableConnectionIconById = new Map<string, string>();
    const prev = makeProps({
      message: sharedUserMessage,
      onToolClick: stableOnToolClick,
      onConsoleTitleClick: stableOnConsoleTitleClick,
      connectionIconById: stableConnectionIconById,
      isLastMessage: false,
      isStreaming: true,
    });
    const next = makeProps({
      message: sharedUserMessage,
      onToolClick: stableOnToolClick,
      onConsoleTitleClick: stableOnConsoleTitleClick,
      connectionIconById: stableConnectionIconById,
      isLastMessage: false,
      isStreaming: true,
    });
    expect(chatMessageRowArePropsEqual(prev, next)).toBe(true);
  });

  it("REGRESSION: returns false even when mutated-in-place content appears equal", () => {
    // Simulates the AI SDK bug surface: the raw message object is mutated
    // in-place between chunks (text grows), and the "clone" of that raw
    // message is compared against it. A content-based comparator would
    // incorrectly see them as identical because both reflect the latest
    // mutated state. Reference inequality must trigger re-render regardless.
    const rawMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "Hel" }],
    };

    const prevProps = makeProps({ message: rawMessage });

    // First render happened with rawMessage. Now AI SDK mutates it in place:
    rawMessage.parts[0].text = "Hello world, streaming in progress...";

    // Next render uses a clone of the now-mutated state:
    const cloneMessage = {
      id: rawMessage.id,
      role: rawMessage.role,
      parts: rawMessage.parts.map(p => ({ ...p })),
    };
    const nextProps = makeProps({ message: cloneMessage });

    // Content is identical. Reference is different. Must re-render.
    expect(chatMessageRowArePropsEqual(prevProps, nextProps)).toBe(false);
  });
});

// ── Structural regression guards ─────────────────────────────
// These tests read the Chat.tsx source and verify critical patterns
// are present, catching regressions that slip past runtime tests.

// ── StreamingToolCard comparator ────────────────────────────
//
// Contract: value-based comparison so completed (terminal-state) tool
// cards skip re-render when useChat's `replaceMessage` hands us fresh
// `structuredClone`d `input` / `output` references every tick while text
// streams below them. A previous reference-equality comparator caused
// completed tool cards to feel unresponsive (~20 re-renders/sec during a
// streaming text reply).

describe("StreamingToolCard memo comparator", () => {
  // React.memo stores the custom comparator on `.compare`.
  const compare = (StreamingToolCard as any).compare as (
    prev: Record<string, unknown>,
    next: Record<string, unknown>,
  ) => boolean;

  function baseProps(over: Record<string, unknown> = {}) {
    return {
      toolCallId: "tool-1",
      toolName: "run_console",
      state: "output-available",
      input: { query: "SELECT 1" },
      output: { success: true, rowCount: 1 },
      onDetailClick: () => {},
      ...over,
    };
  }

  it("exposes a custom comparator (React.memo with areEqual)", () => {
    expect(typeof compare).toBe("function");
  });

  it("skips re-render when a completed tool card's input/output refs churn", () => {
    // useChat clones the message every tick → input / output get new refs
    // even though their contents are immutable for terminal states.
    const prev = baseProps();
    const next = baseProps({
      input: { query: "SELECT 1" }, // same content, new ref
      output: { success: true, rowCount: 1 }, // same content, new ref
    });
    expect(compare(prev, next)).toBe(true);
  });

  it("re-renders when an active input-streaming tool's streamed field grows", () => {
    const prev = baseProps({
      state: "input-streaming",
      input: { query: "SELECT" },
      output: undefined,
    });
    const next = baseProps({
      state: "input-streaming",
      input: { query: "SELECT 1" },
      output: undefined,
    });
    expect(compare(prev, next)).toBe(false);
  });

  it("re-renders when state transitions (e.g. input-streaming → output-available)", () => {
    const prev = baseProps({
      state: "input-streaming",
      input: { query: "SELECT 1" },
      output: undefined,
    });
    const next = baseProps({
      state: "output-available",
      input: { query: "SELECT 1" },
      output: { success: true, rowCount: 1 },
    });
    expect(compare(prev, next)).toBe(false);
  });

  it("re-renders when toolCallId changes (defensive — keys normally catch this)", () => {
    const prev = baseProps({ toolCallId: "tool-1" });
    const next = baseProps({ toolCallId: "tool-2" });
    expect(compare(prev, next)).toBe(false);
  });

  it("skips re-render when input and output references are identical", () => {
    const sharedInput = { query: "SELECT 1" };
    const sharedOutput = { success: true, rowCount: 1 };
    const prev = baseProps({
      state: "input-available",
      input: sharedInput,
      output: sharedOutput,
    });
    const next = baseProps({
      state: "input-available",
      input: sharedInput,
      output: sharedOutput,
    });
    expect(compare(prev, next)).toBe(true);
  });
});

describe("Chat.tsx structural guards", () => {
  const chatSource = fs.readFileSync(
    path.resolve(__dirname, "../Chat.tsx"),
    "utf-8",
  );

  it("useChat has experimental_throttle configured", () => {
    // Without a throttle, reference-equality re-renders would fire on every
    // SSE chunk (~30/s) and make the UI unresponsive.
    expect(chatSource).toMatch(/experimental_throttle\s*:\s*\d+/);
  });

  it("uses use-stick-to-bottom for scroll management", () => {
    expect(chatSource).toContain("useStickToBottom");
  });

  it("does NOT have a DIY useEffect([messages]) auto-scroll", () => {
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

  it("keys tool parts by toolCallId so completed cards don't remount", () => {
    // Remounting a finished tool card on every parts-array mutation drops
    // its internal expand/scroll state and causes a flicker. Keying by
    // toolCallId keeps identity stable across reorders/inserts.
    expect(chatSource).toMatch(/key=\{\s*key\s*\}/);
    expect(chatSource).toMatch(/`tool-\$\{toolCallId\}`/);
  });
});

describe("StreamingMarkdown structural guards", () => {
  const sdSource = fs.readFileSync(
    path.resolve(__dirname, "../StreamingMarkdown.tsx"),
    "utf-8",
  );

  it('does NOT force mode="static" on Streamdown', () => {
    // Streamdown's default mode is "streaming", which already splits content
    // into memoized blocks so only the last (growing) block re-renders per
    // chunk. Forcing static duplicates that work and defeats per-block memo.
    expect(sdSource).not.toMatch(/mode\s*=\s*["']static["']/);
  });

  it("does NOT import remend directly (Streamdown handles it internally)", () => {
    expect(sdSource).not.toMatch(/from\s+["']remend["']/);
  });

  it("forwards isAnimating to Streamdown", () => {
    // Lets Streamdown treat the trailing block as incomplete while streaming.
    expect(sdSource).toMatch(/isAnimating=\{isStreaming\}/);
  });
});
