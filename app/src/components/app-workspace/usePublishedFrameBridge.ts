import { useEffect, useRef } from "react";
import { useConsoleStore } from "../../store/consoleStore";
import { appFrameMessageOrigin } from "../../lib/app-frame";
import {
  APP_DUCKDB_MEMORY_MESSAGE,
  clearAppFrame,
  reportAppFrameMemory,
} from "../../lib/app-memory";

/**
 * THE APP'S QUERY STRING, PROJECTED ONTO THE ADDRESS BAR.
 *
 * The published app is a sandboxed iframe with an opaque origin: its own
 * URL is invisible and unshareable, so the SDK posts the query on every
 * navigate() and the tab carries it (metadata.appSearch). tabUrlPath puts
 * it on the address bar, UrlSync captures it from a shared link into the
 * tab, and the iframe boots from it (`seededSearch`). Only the published
 * iframe is trusted as a source, and only the query is taken — never a path.
 * The same channel reports the frame's DuckDB heap for the page-wide budget.
 */
export function usePublishedFrameBridge({
  tabId,
  previewNonce,
  viewUrl,
  editing,
}: {
  tabId: string;
  previewNonce: number;
  viewUrl: string | undefined;
  editing: boolean;
}) {
  const pubIframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = pubIframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.origin !== appFrameMessageOrigin(frame.src)) return;
      const data = event.data as {
        type?: unknown;
        search?: unknown;
        bytes?: unknown;
        canRelease?: unknown;
      } | null;
      // SDK >= 2.13: what this frame's heap holds, for the page-wide
      // budget across app frames (lib/app-memory.ts).
      if (
        data?.type === APP_DUCKDB_MEMORY_MESSAGE &&
        typeof data.bytes === "number"
      ) {
        reportAppFrameMemory(
          tabId,
          event.source as Window,
          event.origin,
          data.bytes,
          data.canRelease !== false,
        );
        return;
      }
      if (
        !data ||
        data.type !== "mako-app:navigate" ||
        typeof data.search !== "string"
      ) {
        return;
      }
      const search =
        data.search === "" || data.search.startsWith("?")
          ? data.search
          : `?${data.search}`;
      useConsoleStore.setState(state => {
        const t = state.tabs[tabId];
        if (t?.metadata && t.metadata.appSearch !== search) {
          t.metadata.appSearch = search;
        }
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tabId]);

  // Seeded once per boot — re-read only when the key below remounts the
  // iframe: on an explicit rebuild (previewNonce), or when a shared link
  // lands a DIFFERENT query on this already-open tab (appSearchSeed, bumped
  // by focusAppsTab). It must NOT follow every navigate(): a src that changed
  // on each filter would reload the app and throw away exactly the state
  // being kept. Without the seed, a deep link into an open tab kept the
  // query on the address bar while the app inside still showed its old view.
  const appSearchSeed = useConsoleStore(
    s => (s.tabs[tabId]?.metadata?.appSearchSeed as number | undefined) ?? 0,
  );
  const seedKey = `${previewNonce}:${appSearchSeed}`;
  // Each of these replaces or removes the published iframe under a live tab.
  useEffect(
    () => () => clearAppFrame(tabId),
    [tabId, seedKey, viewUrl, editing],
  );
  const seededSearchRef = useRef<{ key: string; search: string } | null>(null);
  if (
    seededSearchRef.current === null ||
    seededSearchRef.current.key !== seedKey
  ) {
    const s = useConsoleStore.getState().tabs[tabId]?.metadata?.appSearch;
    seededSearchRef.current = {
      key: seedKey,
      search: typeof s === "string" && s.length > 1 ? s : "",
    };
  }

  return {
    pubIframeRef,
    seedKey,
    seededSearch: seededSearchRef.current.search,
  };
}
