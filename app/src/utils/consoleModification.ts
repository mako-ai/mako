import { ConsoleModification } from "../hooks/useMonacoConsole";

const MAX_DIFF_BODY_LINES = 120;

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

function withLinePrefix(prefix: string, content: string): string[] {
  if (!content) return [];
  return content.split("\n").map(line => `${prefix}${line}`);
}

function limitDiffBodyLines(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_BODY_LINES) return lines;

  const visibleLines = MAX_DIFF_BODY_LINES - 1;
  const headCount = Math.ceil(visibleLines / 2);
  const tailCount = Math.floor(visibleLines / 2);
  const omittedCount = lines.length - headCount - tailCount;

  return [
    ...lines.slice(0, headCount),
    `... ${omittedCount} diff lines omitted ...`,
    ...lines.slice(-tailCount),
  ];
}

function formatDiffPreview(header: string, bodyLines: string[]): string {
  return [header, ...limitDiffBodyLines(bodyLines)].join("\n");
}

/**
 * Build a compact unified-diff preview for a console modification.
 * The preview is intentionally local to the changed region so tool cards stay
 * readable even when the console is large.
 */
export function buildModificationDiff(
  currentContent: string,
  modification: ConsoleModification,
): string {
  const currentLines = currentContent.split("\n");
  const contentLines = modification.content
    ? modification.content.split("\n")
    : [];

  switch (modification.action) {
    case "patch": {
      const startLine = modification.startLine ?? 1;
      const endLine = modification.endLine ?? startLine;
      const safeStartLine = Math.max(
        1,
        Math.min(startLine, currentLines.length),
      );
      const safeEndLine = Math.max(
        safeStartLine,
        Math.min(endLine, currentLines.length),
      );
      const removedLines = currentLines.slice(safeStartLine - 1, safeEndLine);
      return formatDiffPreview(
        `@@ -${safeStartLine},${removedLines.length} +${safeStartLine},${contentLines.length} @@`,
        [
          ...withLinePrefix("-", removedLines.join("\n")),
          ...withLinePrefix("+", modification.content),
        ],
      );
    }

    case "insert": {
      const line = modification.position?.line ?? 1;
      return formatDiffPreview(
        `@@ -${line},0 +${line},${contentLines.length} @@`,
        withLinePrefix("+", modification.content),
      );
    }

    case "append": {
      const line = currentLines.length + 1;
      return formatDiffPreview(
        `@@ -${line},0 +${line},${contentLines.length} @@`,
        withLinePrefix("+", modification.content),
      );
    }

    case "replace": {
      return formatDiffPreview(
        `@@ -1,${currentLines.length} +1,${contentLines.length} @@`,
        [
          ...withLinePrefix("-", currentContent),
          ...withLinePrefix("+", modification.content),
        ],
      );
    }

    default:
      return "";
  }
}
