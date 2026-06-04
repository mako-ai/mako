export interface ReasoningGroup {
  text: string;
  lastIndex: number;
}

export function computeReasoningGroups(
  parts: Array<Record<string, unknown>>,
): Map<number, ReasoningGroup> {
  const groups = new Map<number, ReasoningGroup>();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "reasoning") continue;
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!text) {
      for (const [, group] of groups) {
        if (group.lastIndex === i - 1) {
          group.lastIndex = i;
          break;
        }
      }
      continue;
    }

    const prevIndex = i - 1;
    let groupStart = i;
    for (const [start, group] of groups) {
      if (group.lastIndex === prevIndex) {
        groupStart = start;
        break;
      }
    }

    if (groupStart === i) {
      groups.set(i, { text, lastIndex: i });
    } else {
      const existing = groups.get(groupStart);
      if (existing) {
        existing.text += "\n\n" + text;
        existing.lastIndex = i;
      }
    }
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
