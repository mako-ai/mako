import { useEffect, useRef } from "react";
import {
  takePlacement,
  type AppOpenPlacement,
} from "../lib/app-open-placement";

/** The server credits each heartbeat with this many active seconds. */
export const APP_USAGE_HEARTBEAT_MS = 60_000;

type UsageKind = "open" | "heartbeat";
export type UsageReferrerKind = "internal" | "external" | "direct";

/** A fresh id per view, so the server can attach heartbeats to their open. */
function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through: insecure context or no Web Crypto.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Where the page that shows the app came from, from `document.referrer`:
 * this origin (`internal`), another site (`external`: a link in Slack, an
 * email), or none (`direct`: a bookmark, a desktop app, a stripped referrer).
 */
export function referrerKindOf(
  referrer: string,
  origin: string,
): UsageReferrerKind {
  if (!referrer) return "direct";
  try {
    return new URL(referrer).origin === origin ? "internal" : "external";
  } catch {
    return "direct";
  }
}

/**
 * Fire-and-forget usage report. `keepalive` lets the last beat survive the
 * tab closing; every failure is swallowed — usage numbers must never cost a
 * viewer anything. Raw fetch on purpose: the typed client redirects to
 * /login on a 401, which a background beat must never do.
 */
function sendUsage(
  workspaceId: string,
  appId: string,
  body: {
    kind: UsageKind;
    sessionId: string;
    referrerKind?: UsageReferrerKind;
    placement?: AppOpenPlacement;
  },
): Promise<number | null> {
  try {
    return fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/usage`,
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, source: "app" }),
      },
    ).then(
      res => res.status,
      () => null,
    );
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Report a view of a PUBLISHED app: one `open` the first time `active`
 * turns true, then a `heartbeat` every minute while it stays active and the
 * page is visible — all carrying one per-view `sessionId`. `active` is the
 * caller's "someone is looking at the published app right now" — the
 * published frame has loaded and, in a tab strip, this tab is the one in
 * front. Never pass the dev preview here: the author building an app is not
 * a view of it.
 */
export function useAppUsageBeacon(input: {
  workspaceId: string | undefined;
  appId: string | undefined;
  active: boolean;
  referrerKind?: UsageReferrerKind;
}): void {
  const { workspaceId, appId, active, referrerKind } = input;
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const openedFor = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // The app was not found (or became invisible): stop reporting it.
  const goneFor = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !appId || !active) return;
    const key = `${workspaceId}:${appId}`;
    if (openedFor.current === key) return;
    openedFor.current = key;
    const sessionId = newSessionId();
    sessionRef.current = sessionId;
    // Opened from a card on the Apps home: say which one.
    const placement = takePlacement(appId);
    void sendUsage(workspaceId, appId, {
      kind: "open",
      sessionId,
      ...(referrerKind ? { referrerKind } : {}),
      ...(placement ? { placement } : {}),
    }).then(status => {
      if (status === 404 || status === 403) goneFor.current = key;
    });
  }, [active, workspaceId, appId, referrerKind]);

  useEffect(() => {
    if (!workspaceId || !appId) return;
    const key = `${workspaceId}:${appId}`;
    const timer = setInterval(() => {
      if (!activeRef.current || goneFor.current === key) return;
      const sessionId = sessionRef.current;
      if (openedFor.current !== key || !sessionId) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void sendUsage(workspaceId, appId, { kind: "heartbeat", sessionId });
    }, APP_USAGE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [workspaceId, appId]);
}
