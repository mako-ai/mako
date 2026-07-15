/**
 * Notebook presence driver.
 *
 * Heartbeats this client's viewer state (who + which cell is focused) to the
 * presence route, expires stale peers, and returns the live *remote* viewers
 * (self excluded) for the avatar row + per-cell cursor / soft-lock indicators.
 *
 * Cadence: an immediate beat on open and whenever the focused cell changes
 * (responsive cursors), plus a periodic keep-alive; a `gone` beacon on close so
 * peers drop us at once (the TTL is the fallback). When a previously-unseen
 * peer appears we re-beat once (throttled) so a newcomer populates everyone's
 * avatar row within a round-trip instead of waiting a full heartbeat.
 */
import { useEffect, useRef, useState } from "react";

import { apiClient } from "../lib/api-client";
import { getApiBasePath } from "../lib/api-base-path";
import { realtimeClientId } from "../lib/realtime-client-id";
import {
  NOTEBOOK_VIEWER_TTL_MS,
  useNotebookPresenceStore,
  type NotebookViewer,
} from "../store/notebookPresenceStore";

const HEARTBEAT_MS = 10_000;
const EXPIRE_TICK_MS = 5_000;
const ECHO_THROTTLE_MS = 2_000;

interface UseNotebookPresenceArgs {
  workspaceId: string | null;
  notebookId: string;
  activeCellId: string | null;
}

export function useNotebookPresence({
  workspaceId,
  notebookId,
  activeCellId,
}: UseNotebookPresenceArgs): NotebookViewer[] {
  const viewersMap = useNotebookPresenceStore(s => s.viewers[notebookId]);

  // Read the latest focused cell from the keep-alive without resubscribing it.
  const activeCellRef = useRef(activeCellId);
  activeCellRef.current = activeCellId;

  const path = workspaceId
    ? `/workspaces/${workspaceId}/notebooks/${notebookId}/presence`
    : null;

  // Keep-alive: beat on open + every HEARTBEAT_MS. Interval only; the leave
  // beacon lives in its own effect so it fires on unmount, not on re-runs.
  useEffect(() => {
    if (!path) return;
    const beat = () =>
      void apiClient
        .post(path, {
          clientId: realtimeClientId,
          activeCellId: activeCellRef.current,
        })
        .catch(() => undefined);
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [path, activeCellId]);

  // Announce departure once, on unmount / notebook switch.
  useEffect(() => {
    if (!path) return;
    return () => {
      const payload = JSON.stringify({
        clientId: realtimeClientId,
        gone: true,
      });
      const url = `${getApiBasePath(import.meta.env.VITE_API_URL)}${path}`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          url,
          new Blob([payload], { type: "application/json" }),
        );
      } else {
        void apiClient
          .post(path, { clientId: realtimeClientId, gone: true })
          .catch(() => undefined);
      }
    };
  }, [path]);

  // Echo once (throttled) when a new peer appears, so newcomers see everyone.
  const knownPeers = useRef<Set<string>>(new Set());
  const lastEcho = useRef(0);
  useEffect(() => {
    if (!path) return;
    let fresh = false;
    for (const clientId of Object.keys(viewersMap ?? {})) {
      if (clientId === realtimeClientId) continue;
      if (!knownPeers.current.has(clientId)) {
        knownPeers.current.add(clientId);
        fresh = true;
      }
    }
    if (!fresh) return;
    const now = Date.now();
    if (now - lastEcho.current < ECHO_THROTTLE_MS) return;
    lastEcho.current = now;
    void apiClient
      .post(path, {
        clientId: realtimeClientId,
        activeCellId: activeCellRef.current,
      })
      .catch(() => undefined);
  }, [path, viewersMap]);

  // Re-render on a timer so viewers whose beats stopped drop off even when no
  // other presence event is arriving.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), EXPIRE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  return Object.values(viewersMap ?? {}).filter(
    v =>
      v.clientId !== realtimeClientId &&
      now - v.lastSeen < NOTEBOOK_VIEWER_TTL_MS,
  );
}
