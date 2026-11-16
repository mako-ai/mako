import { useCallback, useEffect, useRef } from "react";
import { useAppsStore } from "../../store/appsStore";

/** At most one activity report per this window; also the heartbeat period. */
export const PREVIEW_ACTIVITY_EVERY_MS = 60_000;

/**
 * The heartbeat stops this long after the last interaction this page could
 * see (a click into the frame, the pointer over it). Someone working inside
 * the frame keeps moving the pointer across it; a frame left focused and
 * walked away from stops counting after 30 minutes.
 */
export const PREVIEW_HEARTBEAT_MAX_MS = 30 * 60_000;

/**
 * Report real use of the live preview so the sandbox is not paused under
 * someone who is using it.
 *
 * The sandbox pauses after 10 minutes without real activity (edits, agent
 * turns, terminal input, preview use). Polls from an open tab do not count,
 * by design. The preview is a cross-origin iframe, so its clicks, keys and
 * scrolls never reach this page. What this page CAN see, and counts:
 *
 * - the window losing focus to the preview frame (a click into it);
 * - a heartbeat every 60 s while the tab is visible, the browser window has
 *   focus, and that focus is in the preview frame, for at most 30 minutes
 *   after the last click or pointer movement this page saw;
 * - the pointer entering or moving over the preview container.
 */
export function usePreviewActivity(
  workspaceId: string,
  appId: string,
  frame: React.RefObject<HTMLIFrameElement | null>,
): { onPointerEnter: () => void; onPointerMove: () => void } {
  const reportBoxActivity = useAppsStore(s => s.reportBoxActivity);
  const lastReport = useRef(0);
  const lastSeen = useRef(0);

  const send = useCallback(() => {
    const now = Date.now();
    if (now - lastReport.current < PREVIEW_ACTIVITY_EVERY_MS) return;
    lastReport.current = now;
    void reportBoxActivity(workspaceId, appId);
  }, [reportBoxActivity, workspaceId, appId]);

  /** A direct interaction: report it and re-arm the heartbeat. */
  const report = useCallback(() => {
    lastSeen.current = Date.now();
    send();
  }, [send]);

  useEffect(() => {
    const frameFocused = () =>
      !!frame.current && document.activeElement === frame.current;
    const onBlur = () => {
      // The window lost focus to the preview frame: a click into it.
      if (frameFocused()) report();
    };
    const heartbeat = setInterval(() => {
      // activeElement stays on the frame after the person switches to
      // another app, so the window itself must have focus too.
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        frameFocused() &&
        Date.now() - lastSeen.current < PREVIEW_HEARTBEAT_MAX_MS
      ) {
        send();
      }
    }, PREVIEW_ACTIVITY_EVERY_MS);
    window.addEventListener("blur", onBlur);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("blur", onBlur);
    };
  }, [frame, report, send]);

  return { onPointerEnter: report, onPointerMove: report };
}
