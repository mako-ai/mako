import { create } from "zustand";

import { api, unwrapBody } from "../api";
import { getApiBasePath } from "../lib/api-base-path";
import { realtimeClientId } from "../lib/realtime-client-id";
import { onRealtimeEvent } from "./lib/realtime-channel";

/**
 * Live "who's in this notebook" state — presence, live cursors, and soft cell
 * locks. Fed by `notebook.presence` realtime events (each open notebook
 * heartbeats ~every 10s, and immediately when the focused cell changes).
 * Ephemeral and never persisted: a viewer TTL-expires when its beats stop, or
 * is dropped immediately on a `gone` beat (tab closed).
 */
export const NOTEBOOK_VIEWER_TTL_MS = 30_000;

export interface NotebookViewer {
  clientId: string;
  userId: string;
  userName: string;
  /** The cell this viewer is focused on, or null if none (their live cursor). */
  activeCellId: string | null;
  lastSeen: number;
}

/**
 * Stable, distinct colour per user for avatars + cell indicators, derived from
 * the userId so every client agrees on a given user's colour without the server
 * assigning one. Anonymous users (no id) fall back to the clientId.
 */
const PRESENCE_COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#db2777", // pink
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#dc2626", // red
  "#4f46e5", // indigo
  "#65a30d", // lime
  "#c026d3", // fuchsia
];

export function presenceColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

/** Up-to-two-letter initials from a display name or email, for avatars. */
export function presenceInitials(name: string): string {
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

interface NotebookPresenceStore {
  /** notebookId -> clientId -> viewer */
  viewers: Record<string, Record<string, NotebookViewer>>;
  touch: (
    notebookId: string,
    viewer: {
      clientId: string;
      userId: string;
      userName: string;
      activeCellId: string | null;
    },
  ) => void;
  remove: (notebookId: string, clientId: string) => void;
  /** Heartbeat this client's viewer state to the presence route
   * (best-effort: failures are swallowed — the next beat retries). */
  beat: (
    workspaceId: string,
    notebookId: string,
    activeCellId: string | null,
  ) => void;
  /** Announce departure. Uses `sendBeacon` where available because it runs
   * on unmount/page unload, when a normal request may be cancelled. */
  leave: (workspaceId: string, notebookId: string) => void;
}

function sendPresence(
  workspaceId: string,
  notebookId: string,
  body: { clientId: string; activeCellId?: string | null; gone?: boolean },
): void {
  void api
    .POST("/api/workspaces/{workspaceId}/notebooks/{id}/presence", {
      params: { path: { workspaceId, id: notebookId } },
      body,
    })
    .then(unwrapBody)
    .catch(() => undefined);
}

export const useNotebookPresenceStore = create<NotebookPresenceStore>(set => ({
  viewers: {},
  beat: (workspaceId, notebookId, activeCellId) =>
    sendPresence(workspaceId, notebookId, {
      clientId: realtimeClientId,
      activeCellId,
    }),
  leave: (workspaceId, notebookId) => {
    const body = { clientId: realtimeClientId, gone: true };
    if (navigator.sendBeacon) {
      // Raw URL on purpose: a beacon cannot go through the API client. It
      // carries the session cookie; the workspace is in the path.
      const url = `${getApiBasePath(import.meta.env.VITE_API_URL)}/workspaces/${workspaceId}/notebooks/${notebookId}/presence`;
      navigator.sendBeacon(
        url,
        new Blob([JSON.stringify(body)], { type: "application/json" }),
      );
    } else {
      sendPresence(workspaceId, notebookId, body);
    }
  },
  touch: (notebookId, viewer) =>
    set(state => {
      const forNotebook = { ...(state.viewers[notebookId] ?? {}) };
      forNotebook[viewer.clientId] = { ...viewer, lastSeen: Date.now() };
      return { viewers: { ...state.viewers, [notebookId]: forNotebook } };
    }),
  remove: (notebookId, clientId) =>
    set(state => {
      const forNotebook = state.viewers[notebookId];
      if (!forNotebook || !forNotebook[clientId]) return state;
      const next = { ...forNotebook };
      delete next[clientId];
      return { viewers: { ...state.viewers, [notebookId]: next } };
    }),
}));

// ── Realtime reaction (presence frames route straight into this store) ──
onRealtimeEvent("notebook.presence", "notebookPresenceStore", event => {
  const presence = useNotebookPresenceStore.getState();
  if (event.gone) {
    presence.remove(event.notebookId, event.clientId);
    return;
  }
  presence.touch(event.notebookId, {
    clientId: event.clientId,
    userId: event.userId,
    userName: event.userName,
    activeCellId: event.activeCellId ?? null,
  });
});
