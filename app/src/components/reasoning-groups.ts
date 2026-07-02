// Helpers for grouping assistant "reasoning" (thinking) parts into display
// blocks and determining which block is currently streaming.
//
// Extracted from Chat.tsx so the grouping/streaming logic can be unit tested
// without importing the full Chat component tree.

export interface ReasoningGroup {
  text: string;
  // Index of the LAST reasoning part in this run (used both to decide which
  // block owns the trailing stream and to read that part's live `state`).
  lastIndex: number;
}

type Part = Record<string, unknown>;

// Live-streamed parts use `text`; persisted/history parts may use `reasoning`.
// Accept either so grouping is consistent across both.
function partText(p: Part): string {
  if (typeof p.text === "string") return p.text;
  if (typeof p.reasoning === "string") return p.reasoning as string;
  return "";
}

// Anthropic extended-thinking blocks carry a unique per-block `signature` at
// `providerMetadata.anthropic.signature`. Two reasoning parts sharing a
// signature are unambiguously the SAME block (see the backend's
// `dedupeAssistantReasoning`), so we use it as the primary dedupe key.
function partSignature(p: Part): string | null {
  const meta = p.providerMetadata as Record<string, unknown> | undefined | null;
  const anthropic = meta?.anthropic as
    | Record<string, unknown>
    | undefined
    | null;
  const sig = anthropic?.signature;
  return typeof sig === "string" && sig.length > 0 ? sig : null;
}

// True for the AI SDK step boundary marker. A `step-start` sits between the
// thinking segments of a multi-step tool loop; it must NOT break a reasoning
// run (see `computeReasoningGroups`).
function isStepStart(p: Part): boolean {
  return p.type === "step-start";
}

interface RunItem {
  text: string;
  sig: string | null;
}

interface KeptItem extends RunItem {
  // Start index of the group this item's text is displayed in. An upgraded
  // duplicate keeps the EARLIER group's start: the later copy folds into the
  // block that already rendered, never the other way around.
  runStart: number;
}

// De-duplicates reasoning items ACROSS the whole message, not just within one
// contiguous run.
//
// WHY: continuation mode (streamed parts merged with `originalMessages`) and
// resumable-stream replay inject DUPLICATE reasoning parts into a single
// assistant message. Production data shows most duplicate pairs are separated
// by REAL parts (text, tool calls) — the same thinking block, same Anthropic
// signature, persisted twice with a tool call between the copies. Run-scoped
// dedup never sees those, so they render as two thinking blocks with the same
// text. Dedup keys mirror the backend's `dedupeAssistantReasoning`: Anthropic
// signature first, then exact text, then prefix-superset (the streaming-grow /
// replay shape).
//
// LAYOUT RULE: later duplicates always fold into the EARLIER occurrence. The
// earlier block is collapsed by then (only its label is visible), so upgrading
// its hidden text is layout-neutral; dropping or reflowing the earlier block
// would shift everything below it mid-stream.
function dedupeMessageItems(
  runs: Array<{ start: number; items: RunItem[] }>,
): KeptItem[] {
  const kept: KeptItem[] = [];

  for (const run of runs) {
    for (const item of run.items) {
      const t = item.text;

      // Same signature → unambiguously the same block: keep whichever copy is
      // longer, displayed at the earlier position.
      if (item.sig) {
        const existing = kept.find(k => k.sig === item.sig);
        if (existing) {
          if (t.length > existing.text.length) existing.text = t;
          continue;
        }
      }

      // Exact duplicate anywhere earlier in the message.
      if (kept.some(k => k.text === t)) continue;

      // Streaming-grow / replay: the most recent kept copy is a prefix of this
      // one (or vice versa). Skipped when BOTH carry signatures — distinct
      // signatured blocks are authoritative even if their prose overlaps. A
      // signature-less partial (stream cut before reasoning-end) merging with
      // its signatured replayed copy is exactly the shape we want to absorb.
      const last = kept[kept.length - 1];
      if (last && (!last.sig || !item.sig)) {
        if (t.startsWith(last.text)) {
          last.text = t;
          if (item.sig && !last.sig) last.sig = item.sig;
          continue;
        }
        if (last.text.startsWith(t)) continue;
      }

      kept.push({ text: t, sig: item.sig, runStart: run.start });
    }
  }

  return kept;
}

// Groups consecutive `reasoning` parts into a single display block. A run of
// adjacent reasoning parts (regardless of whether each chunk has text yet) is
// one "thinking" session. A `step-start` marker between reasoning parts does
// NOT end the run — multi-step tool loops interleave `step-start` between
// thinking segments, and (critically) resume/continuation replay re-emits a
// `step-start` between a partial reasoning part and its replayed copy. Keeping
// the run intact lets `dedupeRunText` collapse those copies into one block
// instead of rendering the same thinking twice. Any OTHER non-reasoning part
// (tool call, text) genuinely ends the run, so the next reasoning part starts a
// fresh group.
//
// Grouping by contiguous runs — rather than only indexing parts that already
// have text — is important: when a new thinking block begins, its first
// streamed chunk often arrives with empty text. We still create a group for it
// so it forms its own block keyed at its own start index, instead of leaving
// the "last group start" pointing at a previous, already-collapsed block
// (which would make that old block re-expand when the new one starts).
export function computeReasoningGroups(
  parts: Array<Part>,
): Map<number, ReasoningGroup> {
  // Pass 1: collect contiguous runs (bridging step-start markers).
  const runs: Array<{ start: number; lastIndex: number; items: RunItem[] }> =
    [];

  let i = 0;
  while (i < parts.length) {
    if (parts[i].type !== "reasoning") {
      i++;
      continue;
    }

    const start = i;
    const items: RunItem[] = [];
    let lastIndex = i;

    let j = i;
    while (j < parts.length) {
      const p = parts[j];
      if (p.type === "reasoning") {
        const trimmed = partText(p).trim();
        if (trimmed) items.push({ text: trimmed, sig: partSignature(p) });
        lastIndex = j;
        j++;
      } else if (isStepStart(p)) {
        // Bridge the run across the step boundary without extending lastIndex
        // (which must stay on a real reasoning part so its `state` is readable).
        j++;
      } else {
        break;
      }
    }

    runs.push({ start, lastIndex, items });
    i = j;
  }

  // Pass 2: dedupe across the WHOLE message, then rebuild each run's display
  // text from the items that survived in it. A run whose entire content folded
  // into an earlier block gets an empty group — the render skips empty groups
  // unless they're the live streaming block (where an empty "Thinking…" shell
  // is correct while the replayed prefix upgrades the earlier collapsed block).
  const kept = dedupeMessageItems(runs);

  const groups = new Map<number, ReasoningGroup>();
  for (const run of runs) {
    const text = kept
      .filter(k => k.runStart === run.start)
      .map(k => k.text)
      .join("\n\n");
    groups.set(run.start, { text, lastIndex: run.lastIndex });
  }

  return groups;
}

// Does any reasoning part carry a live `state` field? Streamed parts do
// (`'streaming'` → `'done'`); parts rebuilt from persisted history do not.
function hasReasoningState(parts: Array<Part>): boolean {
  return parts.some(p => p.type === "reasoning" && typeof p.state === "string");
}

// The start index of the reasoning group that is currently streaming — i.e. the
// block that should stay force-expanded. Returns null when nothing is streaming,
// so previously-collapsed blocks are never re-opened.
//
// PRIMARY PATH (live streaming): the AI SDK stamps each reasoning part with
// `state: 'streaming' | 'done'`, flipping to `'done'` exactly once at
// reasoning-end. We key the streaming flag off the LAST group's trailing part
// state. This is stable per-token (unlike an index heuristic, which flips as
// empty reasoning parts / step-start markers arrive at the tail) and only ever
// points at the final block — an earlier block left `'streaming'` by a missing
// reasoning-end can never re-open something above the active stream.
//
// FALLBACK PATH (no `state`, e.g. unit fixtures / providers that don't emit it):
// select the group that owns the message's trailing part, and only when that
// trailing part is itself a reasoning part.
export function getStreamingReasoningGroupStart(
  parts: Array<Part>,
  groups: Map<number, ReasoningGroup> = computeReasoningGroups(parts),
): number | null {
  if (groups.size === 0) return null;

  if (hasReasoningState(parts)) {
    let lastStart: number | null = null;
    let lastGroup: ReasoningGroup | null = null;
    for (const [start, group] of groups) {
      lastStart = start;
      lastGroup = group;
    }
    if (lastStart === null || lastGroup === null) return null;
    return parts[lastGroup.lastIndex]?.state === "streaming" ? lastStart : null;
  }

  const lastPartIndex = parts.length - 1;
  const lastPart = parts[lastPartIndex];
  if (lastPart?.type !== "reasoning") return null;

  for (const [start, group] of groups) {
    if (group.lastIndex === lastPartIndex) return start;
  }

  return null;
}
