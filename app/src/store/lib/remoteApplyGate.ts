/**
 * Pure decision logic for applying a remote console copy (revisions-sync
 * entry) to a local tab. Extracted from realtimeStore so the truth table is
 * unit-testable without browsers, stores or Monaco.
 *
 * Decisions:
 *  - "skip"          — tab missing or already at/past the entry's revision;
 *  - "fast-forward"  — local content already matches the server copy:
 *                      advance revision/metadata but DO NOT touch the Monaco
 *                      buffer (it may be ahead by in-flight keystrokes);
 *  - "banner"        — contents diverge while the tab holds unsaved local
 *                      edits: never merge silently, surface the affordance;
 *  - "apply"         — clean tab, divergent content: replace store + buffer.
 */

export interface RemoteApplyDecisionInput {
  /** The console is open as a tab in this window. */
  tabExists: boolean;
  /** Tab's last-synced draft revision (missing counts as 0 = never synced). */
  tabRevision: number | undefined;
  /** The server entry's draft revision. */
  entryRevision: number;
  /** Store content equals the entry content (connection metadata aside). */
  contentMatches: boolean;
  /**
   * The tab holds local edits that are not yet persisted (recent keystrokes,
   * queued/blocked autosave, or an unsaved explicit-save delta). NOTE: this
   * is NOT the `isDirty` pinned-tab flag.
   */
  unsavedLocalEdits: boolean;
}

export type RemoteApplyDecision = "skip" | "fast-forward" | "banner" | "apply";

export function decideRemoteApply(
  input: RemoteApplyDecisionInput,
): RemoteApplyDecision {
  if (!input.tabExists) return "skip";
  if ((input.tabRevision ?? 0) >= input.entryRevision) return "skip";
  if (input.contentMatches) return "fast-forward";
  if (input.unsavedLocalEdits) return "banner";
  return "apply";
}
