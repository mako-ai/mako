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
 * by design. The preview is a cross-origin iframe, so its clicks, keys and
 * scrolls never reach this page. What this page CAN see, and counts:
 *
 * - the window losing focus to the preview frame (a click into it);
 * - a heartbeat every 60 s while the tab is visible AND the preview frame
 *   holds focus (someone is working inside it);
 * - the pointer entering or moving over the preview container.
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
      if (document.visibilityState === "visible" && frameFocused()) report();
    }, PREVIEW_ACTIVITY_EVERY_MS);
    window.addEventListener("blur", onBlur);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("blur", onBlur);
    };
  }, [frame, report]);

  return { onPointerEnter: report, onPointerMove: report };
}
