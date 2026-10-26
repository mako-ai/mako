/**
 * The sandbox a published app's iframe gets, decided by WHERE it is served.
 *
 * Served from Mako's own origin (the default): no `allow-same-origin`. That
 * flag would hand AI-written app code app.mako.ai's cookies, storage and DOM.
 * The frame's origin is opaque, and Chromium never caches anything an
 * opaque-origin frame fetches.
 *
 * Served from the app's own origin (`<appId>.<apps domain>`, when the API has
 * APPS_ORIGIN_BASE set): `allow-same-origin` grants the app ITS OWN foreign
 * origin, never Mako's, and that real origin is what lets the browser cache
 * the DuckDB WASM, the bundle and the parquet between opens.
 *
 * The rule is mechanical so it cannot be got wrong per call site: the flag
 * is added only when the frame URL is cross-origin to this page.
 */
export const APP_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

function originOf(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** True when `src` is served from an origin other than this page's. */
export function isForeignAppFrame(
  src: string,
  pageHref: string = window.location.href,
): boolean {
  const frame = originOf(src, pageHref);
  const page = originOf(pageHref, pageHref);
  return !!frame && !!page && frame !== page;
}

/** The `sandbox` attribute for an app iframe loading `src`. */
export function appFrameSandbox(
  src: string,
  base: string = APP_FRAME_SANDBOX,
  pageHref: string = window.location.href,
): string {
  return isForeignAppFrame(src, pageHref) ? `${base} allow-same-origin` : base;
}

/**
 * The `event.origin` a message from that frame carries: its own origin when
 * foreign, "null" when opaque. Checked on top of `event.source`, so a frame
 * that navigated itself somewhere else is not believed.
 */
export function appFrameMessageOrigin(
  src: string,
  pageHref: string = window.location.href,
): string {
  return isForeignAppFrame(src, pageHref)
    ? (originOf(src, pageHref) ?? "null")
    : "null";
}

/**
 * The app iframe on this page that sent `event`, or null. The same two
 * checks the per-frame listeners make (`event.source` is the frame's window,
 * `event.origin` is the origin it was given), for a listener that does not
 * own a frame ref: any app frame on the page may ask for a host shortcut.
 */
export function appFrameForMessage(
  event: Pick<MessageEvent, "source" | "origin">,
  frames: Iterable<HTMLIFrameElement> = document.querySelectorAll("iframe"),
  pageHref: string = window.location.href,
): HTMLIFrameElement | null {
  if (!event.source) return null;
  for (const frame of frames) {
    if (frame.contentWindow !== event.source) continue;
    const src = frame.getAttribute("src") ?? "";
    return src && event.origin === appFrameMessageOrigin(src, pageHref)
      ? frame
      : null;
  }
  return null;
}
