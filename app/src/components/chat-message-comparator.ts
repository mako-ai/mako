/**
 * Custom React.memo comparator for ChatMessageRow.
 *
 * Extracted to its own file so Chat.tsx only exports components
 * (required by react-refresh/only-export-components).
 */

export interface ChatMessageRowProps {
  message: {
    id: string;
    role: string;
    parts?: Array<Record<string, unknown>>;
  };
  isLastMessage: boolean;
  isStreaming: boolean;
  onToolClick: (tool: any) => void;
  /** Bust memo when MUI palette mode changes so row styles stay in sync */
  paletteMode: "light" | "dark";
}

/**
 * Determines whether a ChatMessageRow can skip re-rendering.
 *
 * Returns `true` (skip render) only when every prop reference is identical.
 *
 * ⚠️  Why reference equality and NOT deep content comparison:
 *
 * The AI SDK's first streaming chunk uses `pushMessage`, which stores the
 * RAW mutable message reference in `messages[last]`. Later chunks call
 * `replaceMessage`, which does `structuredClone(message)` — producing a
 * fresh clone each time. But React.memo's "prev props" are seeded on the
 * FIRST render (with the RAW reference). Subsequent deltas keep mutating
 * that raw object in place (`part.text += chunk.delta`).
 *
 * A content-based comparator would see `prev.message` (RAW, mutated to
 * the current state) and `next.message` (latest clone, also current state)
 * as equal and permanently skip rendering — so text only "appears" when
 * isStreaming flips to false at the end.
 * See `node_modules/@ai-sdk/react/dist/index.mjs` — `ReactChatState.pushMessage`.
 *
 * Reference equality sidesteps this entirely: `structuredClone` produces a
 * new reference on every chunk, so the comparator correctly schedules a
 * re-render. We rely on `experimental_throttle` in `useChat` to batch these
 * into ~20 renders/sec, keeping scroll and hover responsive.
 */
export function chatMessageRowArePropsEqual(
  prev: ChatMessageRowProps,
  next: ChatMessageRowProps,
): boolean {
  if (prev.paletteMode !== next.paletteMode) return false;
  if (prev.isLastMessage !== next.isLastMessage) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.onToolClick !== next.onToolClick) return false;
  return prev.message === next.message;
}
