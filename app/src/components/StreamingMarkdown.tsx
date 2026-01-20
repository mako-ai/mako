/**
 * StreamingMarkdown - Optimized markdown rendering for AI streaming
 *
 * Uses Vercel's streamdown package with Tailwind CSS for styling.
 * https://streamdown.ai/docs/getting-started
 */
import React from "react";
import { Streamdown } from "streamdown";

interface StreamingMarkdownProps {
  children: string;
}

export const StreamingMarkdown: React.FC<StreamingMarkdownProps> = ({
  children,
}) => {
  return (
    <Streamdown shikiTheme={["github-dark", "github-light"]} controls={false}>
      {children}
    </Streamdown>
  );
};

export default StreamingMarkdown;
