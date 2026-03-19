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

export const StreamingMarkdown: React.FC<StreamingMarkdownProps> = ({
  children,
}) => {
  // streamdown and @streamdown/code currently resolve different shiki versions
  // in CI, which makes their exported plugin types incompatible at compile time.
  // The runtime plugin contract is identical, so we bridge via a narrow cast.
  const codePlugin = code as unknown as CodeHighlighterPlugin;

  return (
    <Streamdown
      plugins={{ code: codePlugin }}
      shikiTheme={["github-light", "github-dark"]}
      controls={false}
    >
      {children}
    </Streamdown>
  );
};

export default StreamingMarkdown;
