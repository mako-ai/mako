import { useEffect, useRef } from "react";

/** The server credits each heartbeat with this many active seconds. */
export const APP_USAGE_HEARTBEAT_MS = 60_000;

type UsageKind = "open" | "heartbeat";

/**
 * Fire-and-forget usage report. `keepalive` lets the last beat survive the
 * tab closing; every failure is swallowed — usage numbers must never cost a
 * viewer anything. Raw fetch on purpose: the typed client redirects to
 * /login on a 401, which a background beat must never do.
 */
function sendUsage(
  workspaceId: string,
  appId: string,
  kind: UsageKind,
): Promise<number | null> {
  try {
    return fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appId)}/usage`,
      {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, source: "app" }),
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
 * page is visible. `active` is the caller's "someone is looking at the
 * published app right now" — the published frame has loaded and, in a tab
 * strip, this tab is the one in front. Never pass the dev preview here: the
 * author building an app is not a view of it.
 */
export function useAppUsageBeacon(input: {
  workspaceId: string | undefined;
  appId: string | undefined;
  active: boolean;
}): void {
  const { workspaceId, appId, active } = input;
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const openedFor = useRef<string | null>(null);
  // The app was not found (or became invisible): stop reporting it.
  const goneFor = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !appId || !active) return;
    const key = `${workspaceId}:${appId}`;
    if (openedFor.current === key) return;
    openedFor.current = key;
    void sendUsage(workspaceId, appId, "open").then(status => {
      if (status === 404 || status === 403) goneFor.current = key;
    });
  }, [active, workspaceId, appId]);

  useEffect(() => {
    if (!workspaceId || !appId) return;
    const key = `${workspaceId}:${appId}`;
    const timer = setInterval(() => {
      if (!activeRef.current || goneFor.current === key) return;
      if (openedFor.current !== key) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void sendUsage(workspaceId, appId, "heartbeat");
    }, APP_USAGE_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [workspaceId, appId]);
}
