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
 * Returns `true` (skip render) only when:
 * - `isLastMessage` and `isStreaming` are unchanged, AND
 * - the message reference is identical, OR every part matches by
 *   type, state, and — for text/reasoning parts — exact string content.
 *
 * Streaming parts (`input-streaming`, `output-streaming`) always re-render.
 */
export function chatMessageRowArePropsEqual(
  prev: ChatMessageRowProps,
  next: ChatMessageRowProps,
): boolean {
  if (prev.paletteMode !== next.paletteMode) return false;
  if (prev.isLastMessage !== next.isLastMessage) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.message === next.message) return true;

  const prevParts = prev.message.parts || [];
  const nextParts = next.message.parts || [];
  if (prevParts.length !== nextParts.length) return false;

  for (let i = 0; i < nextParts.length; i++) {
    const pp = prevParts[i];
    const np = nextParts[i];
    if (pp.type !== np.type) return false;
    if (pp.state !== np.state) return false;
    if (np.state === "input-streaming" || np.state === "output-streaming") {
      return false;
    }
    if (pp.type === "text" || pp.type === "reasoning") {
      if ((pp as { text?: string }).text !== (np as { text?: string }).text) {
        return false;
      }
    }
  }

  return true;
}
