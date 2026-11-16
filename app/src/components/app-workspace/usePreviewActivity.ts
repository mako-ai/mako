import { useCallback, useEffect, useRef } from "react";
import { useAppsStore } from "../../store/appsStore";

/** At most one activity report per this window; also the heartbeat period. */
export const PREVIEW_ACTIVITY_EVERY_MS = 60_000;

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
 * A frame left focused in a focused window keeps the box awake. That is the
 * price of not seeing inside the frame; leaving the window ends it.
 */
export function usePreviewActivity(
  workspaceId: string,
  appId: string,
  frame: React.RefObject<HTMLIFrameElement | null>,
): { onPointerEnter: () => void; onPointerMove: () => void } {
  const reportBoxActivity = useAppsStore(s => s.reportBoxActivity);
  const lastReport = useRef(0);

  const report = useCallback(() => {
    const now = Date.now();
    if (now - lastReport.current < PREVIEW_ACTIVITY_EVERY_MS) return;
    lastReport.current = now;
    void reportBoxActivity(workspaceId, appId);
  }, [reportBoxActivity, workspaceId, appId]);

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
        frameFocused()
      ) {
        report();
      }
    }, PREVIEW_ACTIVITY_EVERY_MS);
    window.addEventListener("blur", onBlur);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("blur", onBlur);
    };
  }, [frame, report]);

  return { onPointerEnter: report, onPointerMove: report };
}
