import { useCallback, useEffect, useRef } from "react";
import { useAppsStore } from "../../store/appsStore";

/** At most one activity report per this window. */
const REPORT_EVERY_MS = 60_000;

/**
 * Report real use of the live preview so the sandbox is not paused under
 * someone who is using it.
 *
 * The sandbox pauses after 10 minutes without real activity (edits, agent
 * turns, terminal input, preview use). Polls from an open tab do not count,
 * by design. The preview is a cross-origin iframe, so its clicks and keys
 * never reach this page; what this page CAN see is the pointer entering the
 * frame and the window losing focus to it (a click into the frame). Those
 * two are the preview interaction signal.
 */
export function usePreviewActivity(
  workspaceId: string,
  appId: string,
  frame: React.RefObject<HTMLIFrameElement | null>,
): { onPointerEnter: () => void } {
  const reportBoxActivity = useAppsStore(s => s.reportBoxActivity);
  const lastReport = useRef(0);

  const report = useCallback(() => {
    const now = Date.now();
    if (now - lastReport.current < REPORT_EVERY_MS) return;
    lastReport.current = now;
    void reportBoxActivity(workspaceId, appId);
  }, [reportBoxActivity, workspaceId, appId]);

  useEffect(() => {
    const onBlur = () => {
      // The window lost focus to the preview frame: a click into it.
      if (frame.current && document.activeElement === frame.current) report();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [frame, report]);

  return { onPointerEnter: report };
}
