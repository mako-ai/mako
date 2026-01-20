import { ConsoleModification } from "../hooks/useMonacoConsole";

/**
 * Apply a modification to console content.
 * This is the single source of truth for how modifications are applied.
 *
 * @param currentContent - The current content to modify
 * @param modification - The modification to apply
 * @returns The modified content
 */
export function applyModification(
  currentContent: string,
  modification: ConsoleModification,
): string {
  switch (modification.action) {
    case "replace":
      return modification.content;

    case "append":
      return (
        currentContent +
        (currentContent.endsWith("\n") ? "" : "\n") +
        modification.content
      );

    case "insert": {
      if (!modification.position) {
        return modification.content + currentContent;
      }

      const lines = currentContent.split("\n");
      const { line, column } = modification.position;
      const lineIndex = line - 1;

      if (lineIndex >= 0 && lineIndex < lines.length) {
        const targetLine = lines[lineIndex];
        const before = targetLine.slice(0, column - 1);
        const after = targetLine.slice(column - 1);
        lines[lineIndex] = before + modification.content + after;
      }

      return lines.join("\n");
    }

    case "patch": {
      const { startLine, endLine } = modification;
      if (startLine && endLine) {
        const lines = currentContent.split("\n");
        const safeStartLine = Math.max(1, Math.min(startLine, lines.length));
        const safeEndLine = Math.max(
          safeStartLine,
          Math.min(endLine, lines.length),
        );
        // Replace lines from startLine to endLine (1-indexed, inclusive)
        const before = lines.slice(0, safeStartLine - 1);
        const after = lines.slice(safeEndLine);
        // Split content by newlines to properly insert multi-line patches
        const contentLines = modification.content.split("\n");
        return [...before, ...contentLines, ...after].join("\n");
      }
      return modification.content;
    }

    default:
      return currentContent;
  }
}
