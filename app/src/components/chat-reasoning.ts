export interface ReasoningGroup {
  text: string;
  lastIndex: number;
}

// Groups contiguous assistant "reasoning" parts into display blocks. A
// just-started thinking block can arrive with empty text, so empty runs still
// need their own group identity; otherwise the previous completed group can be
// mistaken for the active streaming block and re-open.
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
      const part = parts[i];
      const rawText =
        typeof part.text === "string"
          ? part.text
          : typeof part.reasoning === "string"
            ? part.reasoning
            : "";
      const trimmed = rawText.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
      lastIndex = i;
      i++;
    }

    groups.set(start, { text: texts.join("\n\n"), lastIndex });
  }

  return groups;
}

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
