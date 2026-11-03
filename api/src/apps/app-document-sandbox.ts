/**
 * The CSP sandbox every app document served on Mako's own origin gets:
 * shares (public-share.ts) and the view-token URL (apps-preview.ts).
 *
 * Opened as a top-level page (a share link, "open in a new tab", a pasted
 * token URL), app code would otherwise run AS app.mako.ai: a signed-in
 * visitor's session cookie rides on any same-origin `fetch("/api/…")` it
 * makes, across every workspace they belong to. The CSP sandbox gives the
 * document an opaque origin instead: no Mako cookies, no Mako storage, and
 * requests to /api are cross-origin (no cookies, response unreadable).
 * Never `allow-same-origin`. Inside Mako's iframe it changes nothing: the
 * two sandboxes intersect to the iframe's own flags.
 *
 * Beyond the in-Mako iframe's flags: downloads (CSV exports) and modals,
 * because a top-level app is a whole page that used to have both.
 *
 * An app on its own origin (app-origin.ts) gets none of this: its origin is
 * already foreign to Mako's.
 */
export const APP_DOCUMENT_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

// Every type a browser renders as a scriptable document when navigated to.
const DOCUMENT_TYPES = [
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
];

/** Set the sandbox on `headers` when their Content-Type is a document. */
export function sandboxAppDocument(headers: Headers): void {
  const type = (headers.get("Content-Type") ?? "").toLowerCase();
  if (DOCUMENT_TYPES.some(t => type.startsWith(t))) {
    headers.set("Content-Security-Policy", APP_DOCUMENT_SANDBOX);
  }
}
