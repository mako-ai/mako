/**
 * Keeping open console tabs in step with the server: realtime remote
 * updates, agent edit review, conflict resolution and draft autosave.
 */
import { unspecced } from "../../api/unspecced";
import { bodyWithStatus } from "../../api";
import { computeConsoleStateHash } from "../../utils/stateHash";
import type { ConsoleSaveResponse } from "../../lib/api-types";
import { realtimeClientId } from "../../lib/realtime-client-id";
import {
  cloudSafeConnectionId,
  draftSaveTimers,
  lastSavedContentHash,
  DRAFT_SAVE_DEBOUNCE_MS,
  blockedDraftSaves,
  pendingAgentReviews,
  cancelAutoSave,
  shouldAutoSave,
  savedStateHashForRemoteEntry,
} from "./runtime";
import type { ConsoleSlice } from "./slice";

type Keys =
  | "setRemoteUpdate"
  | "dismissRemoteUpdate"
  | "applyRemoteConsoleEntry"
  | "fastForwardRemoteConsoleEntry"
  | "beginAgentReview"
  | "resolveAgentReview"
  | "applyRemoteConsoleUpdate"
  | "resolveRemoteUpdateKeepMine"
  | "autoSaveConsole";

export const createConsoleSyncSlice: ConsoleSlice<Keys> = (set, get) => ({
  setRemoteUpdate: (id, info) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        tab.remoteUpdate = info;
      }
    }),

  dismissRemoteUpdate: id => {
    blockedDraftSaves.delete(id);
    // Allow the retry even when content didn't change since the last
    // (rejected) attempt.
    lastSavedContentHash.delete(id);
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        tab.remoteUpdate = null;
      }
    });
  },

  applyRemoteConsoleEntry: entry => {
    const tab = get().tabs[entry.id];
    if (!tab) return;
    const newStateHash = computeConsoleStateHash(
      entry.content,
      entry.connectionId,
      entry.databaseId,
      entry.databaseName,
    );
    set(state => {
      const t = state.tabs[entry.id];
      if (!t) return;
      t.content = entry.content;
      if (entry.name) t.title = entry.name;
      t.connectionId = entry.connectionId;
      t.databaseId = entry.databaseId;
      t.databaseName = entry.databaseName;
      t.draftRevision = entry.draftRevision;
      if (typeof entry.version === "number") t.version = entry.version;
      if (typeof entry.isSaved === "boolean") t.isSaved = entry.isSaved;
      // Refresh the explicit-save baseline from the server when available.
      // Agent drafts are not history versions, so they must not become the
      // baseline that disables Save.
      if (t.isSaved) {
        t.savedStateHash = savedStateHashForRemoteEntry(
          entry,
          tab.savedStateHash,
          newStateHash,
        );
      }
      t.remoteUpdate = null;
      t.lastRun = entry.lastRun ?? t.lastRun;
    });
    // Tab now mirrors the server: any previously blocked autosave state
    // is moot, and an identical autosave would be redundant.
    blockedDraftSaves.delete(entry.id);
    lastSavedContentHash.set(entry.id, newStateHash);
    // Push into the mounted Monaco editor (Editor.tsx listens). The
    // store alone is not enough: Console is uncontrolled after mount.
    window.dispatchEvent(
      new CustomEvent("console-remote-content", {
        detail: { consoleId: entry.id, content: entry.content },
      }),
    );
  },

  fastForwardRemoteConsoleEntry: entry => {
    const tab = get().tabs[entry.id];
    if (!tab) return;
    const newStateHash = computeConsoleStateHash(
      entry.content,
      entry.connectionId,
      entry.databaseId,
      entry.databaseName,
    );
    set(state => {
      const t = state.tabs[entry.id];
      if (!t) return;
      if (entry.name) t.title = entry.name;
      t.connectionId = entry.connectionId;
      t.databaseId = entry.databaseId;
      t.databaseName = entry.databaseName;
      t.draftRevision = entry.draftRevision;
      if (typeof entry.version === "number") t.version = entry.version;
      if (typeof entry.isSaved === "boolean") t.isSaved = entry.isSaved;
      if (t.isSaved) {
        t.savedStateHash = savedStateHashForRemoteEntry(
          entry,
          tab.savedStateHash,
          newStateHash,
        );
      }
      // Server matches local content: any conflict affordance is moot.
      t.remoteUpdate = null;
      t.lastRun = entry.lastRun ?? t.lastRun;
    });
    blockedDraftSaves.delete(entry.id);
    lastSavedContentHash.set(entry.id, newStateHash);
  },

  beginAgentReview: entry => {
    const tab = get().tabs[entry.id];
    if (!tab) return;
    const existing = pendingAgentReviews.get(entry.id);
    // Nothing to review: the proposed content already matches the tab
    // (e.g. a run-artifact/metadata-only bump, an echo, or a stale
    // re-sync after the user just accepted). Still FAST-FORWARD the
    // revision/metadata to the server's current base — otherwise the tab
    // keeps reporting its old draftRevision, so every later sync re-pulls
    // this same "changed" entry and revision-checked writes use a stale
    // base. (Returning without fast-forwarding was a real churn bug.)
    if (!existing && tab.content === entry.content) {
      get().fastForwardRemoteConsoleEntry(entry);
      return;
    }
    // Idempotent: same proposal already on screen — don't re-dispatch
    // (avoids resetting the diff scroll on every unrelated poke).
    if (
      existing &&
      existing.proposedRevision === entry.draftRevision &&
      existing.proposedContent === entry.content
    ) {
      return;
    }
    // Preserve the true baseline across cumulative agent edits: only the
    // FIRST edit captures the pre-agent content/revision.
    const baseContent = existing?.baseContent ?? tab.content;
    const baseRevision = existing?.baseRevision ?? tab.draftRevision ?? 0;
    pendingAgentReviews.set(entry.id, {
      baseContent,
      baseRevision,
      proposedContent: entry.content,
      proposedRevision: entry.draftRevision,
    });
    // A rename and the run artifact are metadata, not part of the content
    // diff: apply them immediately (mirrors applyRemoteConsoleUpdate/
    // fastForward) so the tab title tracks the server and an agent run that
    // accompanied this edit (modify_console + run_console) surfaces its
    // results without waiting for the user to resolve the diff. The
    // Accept/Reject controls govern only the code shown in the diff;
    // content + draftRevision stay on the baseline until the user resolves.
    const proposedName = entry.name;
    set(state => {
      const t = state.tabs[entry.id];
      if (!t) return;
      if (proposedName && proposedName !== t.title) t.title = proposedName;
      if (entry.lastRun) t.lastRun = entry.lastRun;
    });
    // Push the proposal into the mounted Monaco editor as a diff. The
    // store content/revision stay on the baseline until the user
    // resolves the review (Editor.tsx listens).
    window.dispatchEvent(
      new CustomEvent("console-agent-diff", {
        detail: { consoleId: entry.id, content: entry.content },
      }),
    );
  },

  resolveAgentReview: async (workspaceId, consoleId, action) => {
    const review = pendingAgentReviews.get(consoleId);
    if (!review) return;
    pendingAgentReviews.delete(consoleId);
    const tab = get().tabs[consoleId];
    if (!tab) return;

    if (action === "accept") {
      // The server already holds the proposed content at proposedRevision;
      // adopt it locally so the tab mirrors the server. Do not advance
      // savedStateHash: only explicit saves create history versions, and
      // the Save button must stay enabled until the user saves this draft.
      const newStateHash = computeConsoleStateHash(
        review.proposedContent,
        tab.connectionId,
        tab.databaseId,
        tab.databaseName,
      );
      set(state => {
        const t = state.tabs[consoleId];
        if (!t) return;
        t.content = review.proposedContent;
        t.draftRevision = review.proposedRevision;
        t.remoteUpdate = null;
      });
      blockedDraftSaves.delete(consoleId);
      lastSavedContentHash.set(consoleId, newStateHash);
      return;
    }

    // Reject: the agent's content is persisted on the server draft, so a
    // plain local restore would reappear on the next revision sync. Write
    // the pre-agent baseline back with a revision-checked PUT targeting
    // the proposed revision the server currently holds.
    const baseStateHash = computeConsoleStateHash(
      review.baseContent,
      tab.connectionId,
      tab.databaseId,
      tab.databaseName,
    );
    set(state => {
      const t = state.tabs[consoleId];
      if (!t) return;
      t.content = review.baseContent;
      t.remoteUpdate = null;
    });
    try {
      // Same intentional catch-all save endpoint as autosave / keep-mine
      // (not in the documented OpenAPI surface) — called via `unspecced`.
      // Keep the current title (any agent rename already applied and is not
      // part of the rejected content diff).
      const { status, body } = bodyWithStatus<ConsoleSaveResponse>(
        await unspecced.request(
          "PUT",
          `/api/workspaces/${workspaceId}/consoles/${consoleId}`,
          {
            body: {
              content: review.baseContent,
              title: tab.title,
              connectionId: cloudSafeConnectionId(tab.connectionId),
              databaseId: tab.databaseId,
              databaseName: tab.databaseName,
              clientId: realtimeClientId,
              expectedDraftRevision: review.proposedRevision,
            },
          },
        ),
        [409],
      );

      if (status === 409 && body.draftConflict) {
        // Someone wrote concurrently after the agent. If they happened to
        // land on our baseline, just fast-forward; otherwise surface the
        // standard remote-update affordance instead of silently fighting.
        if (body.draftConflict.content === review.baseContent) {
          get().updateDraftRevision(
            consoleId,
            body.draftConflict.currentDraftRevision,
          );
          lastSavedContentHash.set(consoleId, baseStateHash);
        } else {
          get().setRemoteUpdate(consoleId, {
            draftRevision: body.draftConflict.currentDraftRevision,
            kind: "updated",
          });
        }
        return;
      }

      if (body.success) {
        if (typeof body.draftRevision === "number") {
          get().updateDraftRevision(consoleId, body.draftRevision);
        }
        blockedDraftSaves.delete(consoleId);
        lastSavedContentHash.set(consoleId, baseStateHash);
      }
    } catch {
      // Best-effort: the revision base is unchanged, so the next sync
      // re-surfaces the agent edit for review rather than losing data.
    }
  },

  applyRemoteConsoleUpdate: async (workspaceId, consoleId) => {
    // Discarding local edits: a queued autosave would otherwise fire
    // later with the pre-discard content captured in its closure.
    cancelAutoSave(consoleId);
    const res = await get().fetchConsoleContent(workspaceId, consoleId);
    if (!res?.success) return;
    set(state => {
      const t = state.tabs[consoleId];
      if (!t) return;
      t.remoteUpdate = null;
    });
    lastSavedContentHash.set(
      consoleId,
      computeConsoleStateHash(
        res.content || "",
        res.connectionId,
        res.databaseId,
        res.databaseName,
      ),
    );
    window.dispatchEvent(
      new CustomEvent("console-remote-content", {
        detail: { consoleId, content: res.content || "" },
      }),
    );
  },

  resolveRemoteUpdateKeepMine: async (workspaceId, consoleId, content) => {
    const tab = get().tabs[consoleId];
    if (!tab) return;
    try {
      // Deliberate overwrite: target the exact revision the banner told
      // the user about. If the server moved again in the meantime we get
      // another 409 and simply refresh the banner.
      const expectedDraftRevision =
        tab.remoteUpdate?.draftRevision ?? tab.draftRevision;
      // The console save endpoint is an intentional plain-Hono catch-all
      // (`PUT /:path{.+}`) that is not part of the documented OpenAPI
      // surface, so it goes through `unspecced`.
      const { status, body } = bodyWithStatus<ConsoleSaveResponse>(
        await unspecced.request(
          "PUT",
          `/api/workspaces/${workspaceId}/consoles/${consoleId}`,
          {
            body: {
              content,
              title: tab.title,
              connectionId: cloudSafeConnectionId(tab.connectionId),
              databaseId: tab.databaseId,
              databaseName: tab.databaseName,
              clientId: realtimeClientId,
              expectedDraftRevision,
            },
          },
        ),
        [409],
      );

      if (status === 409 && body.draftConflict) {
        get().setRemoteUpdate(consoleId, {
          draftRevision: body.draftConflict.currentDraftRevision,
          kind: "updated",
        });
        return;
      }

      if (body.success) {
        if (typeof body.draftRevision === "number") {
          get().updateDraftRevision(consoleId, body.draftRevision);
        }
        get().setRemoteUpdate(consoleId, null);
        blockedDraftSaves.delete(consoleId);
        lastSavedContentHash.set(
          consoleId,
          computeConsoleStateHash(
            content,
            tab.connectionId,
            tab.databaseId,
            tab.databaseName,
          ),
        );
      }
    } catch {
      // Best-effort; the banner stays until a retry succeeds.
    }
  },

  autoSaveConsole: (
    workspaceId,
    consoleId,
    content,
    title,
    connectionId,
    databaseId,
    databaseName,
  ) => {
    if (!content?.trim() || content === "loading...") return;
    if (!shouldAutoSave(get, consoleId)) return;
    // Conflict pending (banner shown): don't hammer the server with
    // doomed 409s. Edits stay local until the user resolves (Load
    // latest / Keep mine) or a matching remote apply unblocks us.
    if (blockedDraftSaves.has(consoleId)) return;

    const stateHash = computeConsoleStateHash(
      content,
      connectionId,
      databaseId,
      databaseName,
    );
    if (lastSavedContentHash.get(consoleId) === stateHash) {
      // Content is back to the persisted baseline (e.g. type + undo).
      // CANCEL any queued autosave too: it captured an intermediate
      // keystroke state which is now obsolete — letting it fire would
      // persist phantom content the editor no longer shows and steal
      // the revision from concurrent writers.
      const pending = draftSaveTimers.get(consoleId);
      if (pending) {
        clearTimeout(pending);
        draftSaveTimers.delete(consoleId);
      }
      return;
    }

    const existingTimer = draftSaveTimers.get(consoleId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      draftSaveTimers.delete(consoleId);
      if (!shouldAutoSave(get, consoleId)) return;
      if (blockedDraftSaves.has(consoleId)) return;

      try {
        // Revision-checked write (LWW with revision check): if the
        // server draft moved past what this tab last synced, the save is
        // rejected with 409 draft_conflict instead of silently
        // overwriting another tab's / user's / the agent's work.
        const expectedDraftRevision = get().tabs[consoleId]?.draftRevision;
        // Catch-all save endpoint (see note in resolveRemoteUpdateKeepMine);
        // not in the documented OpenAPI surface, goes through `unspecced`.
        const { status, body } = bodyWithStatus<ConsoleSaveResponse>(
          await unspecced.request(
            "PUT",
            `/api/workspaces/${workspaceId}/consoles/${consoleId}`,
            {
              body: {
                content,
                title,
                connectionId: cloudSafeConnectionId(connectionId),
                databaseId,
                databaseName,
                clientId: realtimeClientId,
                expectedDraftRevision,
              },
            },
          ),
          [409],
        );

        if (status === 409 && body.draftConflict) {
          if (body.draftConflict.content === content) {
            // Pure echo: another window/tab already persisted exactly
            // this content (e.g. duplicated autosave). Not a conflict —
            // fast-forward our revision base and move on.
            get().updateDraftRevision(
              consoleId,
              body.draftConflict.currentDraftRevision,
            );
            get().setRemoteUpdate(consoleId, null);
            lastSavedContentHash.set(consoleId, stateHash);
            return;
          }
          // Real conflict: suspend autosave and surface the non-blocking
          // affordance; the user decides (Load latest / Keep mine).
          blockedDraftSaves.add(consoleId);
          get().setRemoteUpdate(consoleId, {
            draftRevision: body.draftConflict.currentDraftRevision,
            kind: "updated",
          });
          return;
        }

        if (body.success) {
          if (typeof body.draftRevision === "number") {
            get().updateDraftRevision(consoleId, body.draftRevision);
          }
          lastSavedContentHash.set(consoleId, stateHash);
        }
      } catch {
        // Auto-save failure - silently ignore as this is a best-effort operation
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);

    draftSaveTimers.set(consoleId, timer);
  },
});
