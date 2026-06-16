import { useEffect, useRef } from "react";
import { useAppVersionStore, CURRENT_BUILD_ID } from "../store/appVersionStore";

/** Background polling interval while the app is open */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Minimum gap between checks triggered by focus/visibility events */
const FOCUS_CHECK_THROTTLE_MS = 60 * 1000;

/**
 * Periodically checks whether a newer frontend build has been deployed.
 *
 * Checks run on an interval and — most importantly for the desktop app, where
 * the window stays open for days — whenever the window regains focus or
 * becomes visible again, throttled so rapid focus changes don't spam the API.
 */
export function useVersionCheck(): void {
  const checkForUpdate = useAppVersionStore(state => state.checkForUpdate);
  const lastCheckAtRef = useRef(0);

  useEffect(() => {
    if (CURRENT_BUILD_ID === "dev") return;

    const check = () => {
      lastCheckAtRef.current = Date.now();
      void checkForUpdate();
    };

    const throttledCheck = () => {
      if (Date.now() - lastCheckAtRef.current < FOCUS_CHECK_THROTTLE_MS) return;
      check();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") throttledCheck();
    };

    // Initial check shortly after load (deferred so it never competes with
    // app startup work).
    const initialTimeout = window.setTimeout(check, 15_000);
    const intervalId = window.setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("focus", throttledCheck);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearTimeout(initialTimeout);
      window.clearInterval(intervalId);
      window.removeEventListener("focus", throttledCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkForUpdate]);
}
