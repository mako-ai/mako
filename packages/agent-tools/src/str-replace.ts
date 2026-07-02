/**
 * Anchored string-replacement engine — single source of truth for how
 * `app_edit_file` / `edit_dbt_file` / binding-query edits are applied and how
 * their compact diff previews are built.
 *
 * Semantics follow the industry-standard agent edit contract (Cursor
 * StrReplace / Claude Code Edit): `oldString` must match the current content
 * exactly once (or `replaceAll` must be set), and failures return structured,
 * model-actionable errors instead of throwing.
 *
 * Pure string-in/string-out: no DOM, no Mongo.
 */

export interface StrReplaceSuccess {
  ok: true;
  contents: string;
  /** Number of occurrences replaced (1 unless `replaceAll`). */
  replacements: number;
}

export interface StrReplaceFailure {
  ok: false;
  reason: "empty_old_string" | "no_change" | "not_found" | "not_unique";
  /** Occurrence count for `not_unique`. */
  occurrences?: number;
  /** Model-actionable message, ready to surface as a tool error. */
  error: string;
}

export type StrReplaceResult = StrReplaceSuccess | StrReplaceFailure;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Apply an anchored string replacement.
 *
 * - Deletion is `newString: ""`.
 * - Insertion anchors on adjacent content (`newString` = anchor + new text).
 * - An empty `oldString` is invalid — creating files / full rewrites go
 *   through the write tool, not the edit tool.
 */
export function applyStrReplace(
  contents: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): StrReplaceResult {
  if (oldString === "") {
    return {
      ok: false,
      reason: "empty_old_string",
      error:
        "oldString must not be empty. To create a new file or fully rewrite one, use the write tool instead.",
    };
  }
  if (oldString === newString) {
    return {
      ok: false,
      reason: "no_change",
      error: "oldString and newString are identical — nothing to change.",
    };
  }

  const occurrences = countOccurrences(contents, oldString);
  if (occurrences === 0) {
    return {
      ok: false,
      reason: "not_found",
      error:
        "oldString was not found in the current content. Re-read the file (its content may have changed) and match the existing text exactly, including whitespace and indentation.",
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      reason: "not_unique",
      occurrences,
      error: `oldString matches ${occurrences} locations. Include more surrounding lines to make the match unique, or pass replaceAll: true to replace every occurrence.`,
    };
  }

  if (replaceAll) {
    return {
      ok: true,
      contents: contents.split(oldString).join(newString),
      replacements: occurrences,
    };
  }

  const index = contents.indexOf(oldString);
  return {
    ok: true,
    contents:
      contents.slice(0, index) +
      newString +
      contents.slice(index + oldString.length),
    replacements: 1,
  };
}

const MAX_DIFF_BODY_LINES = 120;

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

/**
 * Build a compact unified-diff preview for a successful str-replace, local to
 * the (first) changed region so tool cards stay readable in large files. The
 * matched region is expanded to full lines; for `replaceAll` edits a trailer
 * notes how many occurrences were changed.
 */
export function buildStrReplaceDiff(
  contents: string,
  oldString: string,
  newString: string,
  replacements = 1,
): string {
  const index = contents.indexOf(oldString);
  if (index === -1) return "";

  // Expand the match to full-line boundaries for a readable -/+ block.
  const lineStart = contents.lastIndexOf("\n", index - 1) + 1;
  const matchEnd = index + oldString.length;
  const nextNewline = contents.indexOf("\n", matchEnd);
  const lineEnd = nextNewline === -1 ? contents.length : nextNewline;

  const removed = contents.slice(lineStart, lineEnd);
  const added =
    contents.slice(lineStart, index) +
    newString +
    contents.slice(matchEnd, lineEnd);

  const startLineNumber = contents.slice(0, lineStart).split("\n").length;
  const removedCount = removed ? removed.split("\n").length : 0;
  const addedCount = added ? added.split("\n").length : 0;

  const body = [
    ...withLinePrefix("-", removed),
    ...withLinePrefix("+", added),
    ...(replacements > 1
      ? [`(applied to ${replacements} occurrences)`]
      : []),
  ];
  return [
    `@@ -${startLineNumber},${removedCount} +${startLineNumber},${addedCount} @@`,
    ...limitDiffBodyLines(body),
  ].join("\n");
}
