/**
 * StreamingMarkdown - Optimized markdown rendering for AI streaming
 *
 * Uses Vercel's streamdown package with Tailwind CSS for styling.
 * https://streamdown.ai/docs/getting-started
 */
import React from "react";
import { Streamdown, type CodeHighlighterPlugin } from "streamdown";
import { code } from "@streamdown/code";

interface StreamingMarkdownProps {
  children: string;
}

export const StreamingMarkdown: React.FC<StreamingMarkdownProps> = React.memo(
  ({ children }) => {
    return (
      <Streamdown
        // streamdown and @streamdown/code currently expose mismatched shiki typings.
        plugins={{ code: code as unknown as CodeHighlighterPlugin }}
        shikiTheme={["github-light", "github-dark"]}
        controls={false}
      >
        {children}
      </Streamdown>
    );
  },
);

StreamingMarkdown.displayName = "StreamingMarkdown";

export default StreamingMarkdown;
