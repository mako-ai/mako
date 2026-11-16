import { useCallback, useEffect, useRef } from "react";
import { useAppsStore } from "../../store/appsStore";

/** At most one activity report per this window; also the heartbeat period. */
export const PREVIEW_ACTIVITY_EVERY_MS = 60_000;

/**
 * The heartbeat stops this long after the last interaction this page saw (a
 * click into the frame, the pointer entering or moving over it). Two hours
 * is far past any working stretch without the pointer ever leaving the
 * preview, and it bounds a frame left focused on an unattended screen.
 */
export const PREVIEW_HEARTBEAT_MAX_MS = 2 * 60 * 60_000;

/**
 * Report real use of the live preview so the sandbox is not paused under
 * someone who is using it.
 *
 * The sandbox pauses after 10 minutes without real activity (edits, agent
 * turns, terminal input, preview use). Polls from an open tab do not count,
 * by design. The preview is a cross-origin iframe, so its clicks, keys,
 * scrolls and pointer moves never reach this page. What this page CAN see,
 * and counts:
 *
 * - the window losing focus to the preview frame (a click into it);
 * - a heartbeat every 60 s while the tab is visible, the browser window has
 *   focus, and that focus is in the preview frame. Someone working in the
 *   preview holds exactly that state; switching to another app ends it
 *   (`document.hasFocus()` turns false even though activeElement stays on
 *   the frame);
 * - the pointer entering or moving over the preview container.
 *
 * The heartbeat stops 2 hours after the last click or pointer movement this
 * page saw: in-frame input is invisible here, so a frame left focused on an
 * unattended screen would otherwise keep the box awake forever.
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

  /** A direct interaction: report it and re-arm the heartbeat's 2 hours. */
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
