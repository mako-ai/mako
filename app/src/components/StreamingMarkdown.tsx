/**
 * StreamingMarkdown — thin wrapper around Streamdown.
 *
 * Streamdown's default `mode="streaming"` already:
 *   • splits content into independent memoized blocks, so only the last
 *     (still-growing) block re-renders on each chunk;
 *   • runs `remend` internally to close unbalanced markdown mid-stream
 *     (`parseIncompleteMarkdown: true` is its default).
 *
 * We only forward the streaming hint via `isAnimating` so Streamdown knows
 * the trailing block is still being filled in. Everything else is owned by
 * Streamdown.
 *
 * See https://streamdown.ai/docs
 */
import React from "react";
import { Streamdown, type CodeHighlighterPlugin } from "streamdown";
import { code } from "@streamdown/code";

interface StreamingMarkdownProps {
  children: string;
  /**
   * True when this markdown belongs to a part that is still being streamed
   * (e.g. the trailing text block of the active assistant message). Forwarded
   * to Streamdown's `isAnimating` so it treats the last block as incomplete.
   */
  isStreaming?: boolean;
}

export const StreamingMarkdown: React.FC<StreamingMarkdownProps> = React.memo(
  ({ children, isStreaming = false }) => {
    return (
      <Streamdown
        plugins={{ code: code as unknown as CodeHighlighterPlugin }}
        shikiTheme={["github-light", "github-dark"]}
        controls={false}
        isAnimating={isStreaming}
      >
        {children}
      </Streamdown>
    );
  },
);

StreamingMarkdown.displayName = "StreamingMarkdown";

export default StreamingMarkdown;
