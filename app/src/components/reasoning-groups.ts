// Helpers for grouping assistant "reasoning" (thinking) parts into display
// blocks and determining which block is currently streaming.
//
// Extracted from Chat.tsx so the grouping/streaming logic can be unit tested
// without importing the full Chat component tree.

export interface ReasoningGroup {
  text: string;
  lastIndex: number;
}

// Groups consecutive `reasoning` parts into a single display block. A run of
// adjacent reasoning parts (regardless of whether each chunk has text yet) is
// one "thinking" session; any non-reasoning part (tool call, text) ends the
// run, so the next reasoning part starts a fresh group.
//
// Grouping by contiguous runs — rather than only indexing parts that already
// have text — is important: when a new thinking block begins, its first
// streamed chunk often arrives with empty text. We still create a group for it
// so it forms its own block keyed at its own start index, instead of leaving
// the "last group start" pointing at a previous, already-collapsed block
// (which would make that old block re-expand when the new one starts).
export function computeReasoningGroups(
  parts: Array<Record<string, unknown>>,
): Map<number, ReasoningGroup> {
  const groups = new Map<number, ReasoningGroup>();

  let i = 0;
  while (i < parts.length) {
    if (parts[i].type !== "reasoning") {
      i++;
      continue;
    }

    const start = i;
    const texts: string[] = [];
    let lastIndex = i;
    while (i < parts.length && parts[i].type === "reasoning") {
      const p = parts[i];
      // Live-streamed parts use `text`; persisted/history parts may use
      // `reasoning`. Accept either so grouping is consistent across both.
      const raw =
        typeof p.text === "string"
          ? p.text
          : typeof p.reasoning === "string"
            ? (p.reasoning as string)
            : "";
      const trimmed = raw.trim();
      if (trimmed) texts.push(trimmed);
      lastIndex = i;
      i++;
    }

    groups.set(start, { text: texts.join("\n\n"), lastIndex });
  }

  return groups;
}

// The start index of the reasoning group that is currently streaming, i.e. the
// group that owns the message's last part. Returns null when the last part is
// not a reasoning part (so no block should be force-expanded), or when the last
// part somehow belongs to no group.
//
// Selecting by `lastIndex === lastPartIndex` (rather than "the highest group
// start") ties the streaming flag to the group the trailing part actually
// belongs to. Combined with contiguous-run grouping above, a just-started empty
// block forms its own group whose lastIndex is the last part — so it's selected
// here and shows its "Thinking…" indicator immediately, while every earlier,
// already-collapsed block stays closed.
export function getStreamingReasoningGroupStart(
  parts: Array<Record<string, unknown>>,
  groups: Map<number, ReasoningGroup> = computeReasoningGroups(parts),
): number | null {
  const lastPartIndex = parts.length - 1;
  const lastPart = parts[lastPartIndex];
  if (lastPart?.type !== "reasoning") return null;

  for (const [start, group] of groups) {
    if (group.lastIndex === lastPartIndex) return start;
  }

  return null;
}
