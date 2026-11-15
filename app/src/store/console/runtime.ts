/**
 * Module-level console runtime state shared by the slices: per-tab version
 * managers, autosave timers and hashes, pending agent reviews, and the
 * helpers that read them. Not reactive and never persisted.
 */
import { isLocalConnectionId } from "../../lib/local-agent-client";
import { ConsoleVersionManager } from "../../utils/ConsoleVersionManager";
import type { ConsoleTab } from "../lib/types";
import type {
  ConsoleContentResponse,
  ConsoleRevisionSyncEntry,
} from "../../lib/api-types";
import type { ConsoleState } from "./types";

// Store version managers for each console tab
export const versionManagers = new Map<string, ConsoleVersionManager>();
export const versionCommentControllers = new Map<string, AbortController>();
export const versionCommentTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

// Execution IDs routed to the Mako Local Agent, so cancelQuery (which only
// receives the executionId) can target the right backend.
export const localExecutionIds = new Set<string>();

/**
 * Cloud consoles persist connectionId as a Mongo ObjectId reference, which
 * cannot store Local Agent connection ids. Omit local ids from cloud save
 * payloads; the local connection stays selected in the open tab.
 */
export function cloudSafeConnectionId(
  connectionId: string | undefined,
): string | undefined {
  return isLocalConnectionId(connectionId) ? undefined : connectionId;
}

// Debounce timers for draft console saves (per console ID)
export const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Track last saved content hash to avoid redundant API calls
export const lastSavedContentHash = new Map<string, string>();
export const DRAFT_SAVE_DEBOUNCE_MS = 2000; // 2 seconds debounce

// Consoles whose autosave is suspended because the last draft write hit a
// real 409 draft_conflict (server moved past us with DIFFERENT content).
// While a console is blocked we stop hammering the server with doomed
// autosaves; the remote-update banner's "Load latest" / "Keep mine" actions
// (or a remote apply that matches local content) unblock it.
export const blockedDraftSaves = new Set<string>();

// Last user keystroke per console (module-level, non-reactive). The store's
// content lags typing by a debounce (~500ms in Console.tsx), so the realtime
// layer uses this to avoid clobbering keystrokes that landed inside that
// window when a remote update arrives.
export const lastUserEditAt = new Map<string, number>();
export const USER_EDIT_RECENCY_MS = 3000;

export const markUserEditActivity = (consoleId: string): void => {
  lastUserEditAt.set(consoleId, Date.now());
};

export const hasRecentUserEdit = (consoleId: string): boolean => {
  const at = lastUserEditAt.get(consoleId);
  return at !== undefined && Date.now() - at < USER_EDIT_RECENCY_MS;
};

/**
 * Consoles whose latest agent (modify_console) edit is awaiting user review
 * in the Monaco diff view. modify_console runs server-side (issue #475) and
 * the change is already persisted to the draft, but instead of silently
 * replacing the editor we surface it as an Accept/Reject diff (the pre-#475
 * UX). While a console is under review the realtime layer routes further
 * server copies into the diff rather than applying them, and the editor keeps
 * the pre-agent baseline until the user resolves the review. Keyed by
 * consoleId; module-level (non-reactive) like the autosave bookkeeping.
 */
export interface PendingAgentReview {
  /** Store content before the agent's first edit (restored on reject). */
  baseContent: string;
  /** Draft revision the tab held before the agent's first edit. */
  baseRevision: number;
  /** Latest agent-proposed content (the diff's "modified" side). */
  proposedContent: string;
  /** Server draft revision carrying the proposed content. */
  proposedRevision: number;
}

export const pendingAgentReviews = new Map<string, PendingAgentReview>();

export const hasPendingAgentReview = (consoleId: string): boolean =>
  pendingAgentReviews.has(consoleId);

export const getPendingAgentReview = (
  consoleId: string,
): PendingAgentReview | undefined => pendingAgentReviews.get(consoleId);

/** A draft autosave is queued (debounce window) but not yet persisted. */
export const hasPendingDraftSave = (consoleId: string): boolean =>
  draftSaveTimers.has(consoleId);

/** Autosave is suspended pending conflict resolution (banner shown). */
export const hasBlockedDraftSave = (consoleId: string): boolean =>
  blockedDraftSaves.has(consoleId);

export const clearBlockedDraftSave = (consoleId: string): void => {
  blockedDraftSaves.delete(consoleId);
};

export const cancelAutoSave = (consoleId: string): void => {
  const timer = draftSaveTimers.get(consoleId);
  if (timer) {
    clearTimeout(timer);
    draftSaveTimers.delete(consoleId);
  }
  lastSavedContentHash.delete(consoleId);
  blockedDraftSaves.delete(consoleId);
};

export const shouldAutoSave = (
  getState: () => ConsoleState,
  consoleId: string,
) => {
  const tab = getState().tabs[consoleId];
  return tab ? !tab.isSaved : true;
};

export function savedStateHashForRemoteEntry(
  entry: Pick<ConsoleRevisionSyncEntry, "lastDraftOrigin" | "savedStateHash">,
  currentSavedStateHash: string | undefined,
  entryStateHash: string,
): string | undefined {
  if (entry.savedStateHash !== undefined) return entry.savedStateHash;
  if (entry.lastDraftOrigin === "agent" && currentSavedStateHash) {
    return currentSavedStateHash;
  }
  if (entry.lastDraftOrigin === "agent") return undefined;
  return entryStateHash;
}

export function normalizeScheduledRunSnapshotForTab(
  scheduledRun: ConsoleContentResponse["scheduledRun"],
): ConsoleTab["scheduledRun"] {
  const toIso = (v: unknown): string | undefined => {
    if (v == null) return undefined;
    if (typeof v === "string") return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    nextAt: toIso(scheduledRun?.nextAt),
    lastAt: toIso(scheduledRun?.lastAt),
    lastStatus: scheduledRun?.lastStatus,
    lastError: scheduledRun?.lastError,
    lastDurationMs: scheduledRun?.lastDurationMs,
    lastRowsAffected: scheduledRun?.lastRowsAffected,
    lastRowCount: scheduledRun?.lastRowCount,
    runCount: scheduledRun?.runCount ?? 0,
    consecutiveFailures: scheduledRun?.consecutiveFailures ?? 0,
  };
}
