/**
 * Self-capture of sandboxed app-preview iframes.
 *
 * App previews render in opaque-origin iframes (`sandbox="allow-scripts"`),
 * which DOM rasterizers (modern-screenshot) cannot capture from the parent —
 * they come out blank. The preview bootstrap handles `mako-app:capture` and
 * screenshots itself from inside (see preview.ts), returning a PNG data URL.
 *
 * Shared by `capture_screenshot` (composites every visible preview into a
 * page capture) and the `run_app` executor (captures one app's preview as
 * the verify screenshot) — one capture protocol, one implementation.
 */
import { PREVIEW_MESSAGE } from "./preview";

export const APP_PREVIEW_IFRAME_SELECTOR = "iframe[data-mako-app-preview]";

/**
 * Per-iframe self-capture cap. Kept deliberately short: callers are
 * client-only, long-running tools, so the longer this runs the wider the
 * window in which a mobile lock / computer sleep / proxy idle timeout can
 * interrupt the turn and strand the card. A timed-out capture degrades
 * gracefully (reported as a capture failure, never a thrown turn).
 */
export const APP_PREVIEW_CAPTURE_TIMEOUT_MS = 4000;

let captureSeq = 0;

export interface PreviewCaptureOptions {
  scale: number;
  backgroundColor?: string | null;
}

function escapeAttributeValue(value: string): string {
  const css = globalThis.CSS as
    | { escape?: (value: string) => string }
    | undefined;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function isCapturable(iframe: HTMLIFrameElement): boolean {
  const rect = iframe.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8 && iframe.contentWindow != null;
}

/** All visible app-preview iframes inside (or being) the capture target. */
export function findAppPreviewIframes(
  target: HTMLElement,
): HTMLIFrameElement[] {
  const iframes = Array.from(
    target.querySelectorAll<HTMLIFrameElement>(APP_PREVIEW_IFRAME_SELECTOR),
  );
  if (
    target instanceof HTMLIFrameElement &&
    target.matches(APP_PREVIEW_IFRAME_SELECTOR)
  ) {
    iframes.unshift(target);
  }
  return iframes.filter(isCapturable);
}

/** The visible preview iframe for one app (data-mako-app-preview={appId}). */
export function findAppPreviewIframe(appId: string): HTMLIFrameElement | null {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-mako-app-preview="${escapeAttributeValue(appId)}"]`,
  );
  return iframe && isCapturable(iframe) ? iframe : null;
}

/**
 * Ask one preview iframe to screenshot itself; resolves to a PNG data URL.
 */
export function requestAppPreviewCapture(
  iframe: HTMLIFrameElement,
  options: PreviewCaptureOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentWindow = iframe.contentWindow;
    if (!contentWindow) {
      reject(new Error("App preview iframe has no content window"));
      return;
    }
    const requestId = `capture_${Date.now()}_${++captureSeq}`;
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("App preview capture timed out"));
    }, APP_PREVIEW_CAPTURE_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      const data = (event.data ?? {}) as {
        type?: string;
        requestId?: string;
        success?: boolean;
        dataUrl?: string;
        error?: string;
      };
      if (
        event.source !== contentWindow ||
        data.type !== PREVIEW_MESSAGE.captureResult ||
        data.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (data.success && data.dataUrl) resolve(data.dataUrl);
      else reject(new Error(data.error || "App preview capture failed"));
    }

    window.addEventListener("message", onMessage);
    // The sandboxed iframe has an opaque origin, so "*" is required.
    contentWindow.postMessage(
      {
        type: PREVIEW_MESSAGE.capture,
        requestId,
        scale: options.scale,
        backgroundColor: options.backgroundColor,
      },
      "*",
    );
  });
}

/**
 * Capture one app's visible preview iframe as a PNG data URL. Throws when no
 * capturable iframe is on screen (tab not open / preview hidden).
 */
export async function captureAppPreview(
  appId: string,
  options: PreviewCaptureOptions = { scale: 1 },
): Promise<string> {
  const iframe = findAppPreviewIframe(appId);
  if (!iframe) {
    throw new Error(
      "No visible preview iframe for this app — open its tab to capture a screenshot.",
    );
  }
  return requestAppPreviewCapture(iframe, options);
}
