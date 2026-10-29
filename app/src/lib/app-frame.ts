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
 *
 * `allow-downloads` lets an app save a file it built (an Excel export, a
 * CSV) when the user clicks. Without it Chrome drops the download silently.
 */
export const APP_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

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
 * How long the app-host probe may take before the app is framed from Mako's
 * own origin instead. A proxy block page answers fast; a hung connection
 * must not hold the app back for long.
 */
export const APP_HOST_PROBE_TIMEOUT_MS = 4000;

// One probe per app origin per page load. Zscaler and the like block the
// whole apps domain, so a failure is remembered for every app host.
const probes = new Map<string, Promise<boolean>>();
let appsDomainBlocked = false;

async function probeAppHost(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/__mako/ping`, {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The URL to frame for a view token URL. A URL on the app's own origin
 * (`<appId>.<apps domain>`) is used only once that host answers the ping:
 * a corporate proxy that blocks the apps domain answers with its own page
 * and no CORS header, and framing it would show the proxy's error instead
 * of the app. Then the same token path is framed from Mako's own origin,
 * which serves every published token (opaque origin, no cache, but works).
 */
export async function reachableViewUrl(
  url: string,
  {
    fetchImpl = fetch,
    pageHref = window.location.href,
    timeoutMs = APP_HOST_PROBE_TIMEOUT_MS,
  }: {
    fetchImpl?: typeof fetch;
    pageHref?: string;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  if (!isForeignAppFrame(url, pageHref)) return url;
  const parsed = new URL(url, pageHref);
  const sameOrigin = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (appsDomainBlocked) return sameOrigin;
  let probe = probes.get(parsed.origin);
  if (!probe) {
    probe = probeAppHost(parsed.origin, fetchImpl, timeoutMs);
    probes.set(parsed.origin, probe);
  }
  if (await probe) return url;
  appsDomainBlocked = true;
  return sameOrigin;
}

/** Test-only: forget every probe result. */
export function resetAppHostProbes(): void {
  probes.clear();
  appsDomainBlocked = false;
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
