import type { Context, Next } from "hono";

/**
 * Content-Security-Policy for the SPA's HTML documents.
 *
 * Ships as REPORT-ONLY by default: the SPA loads GTM through an inline
 * bootstrap script, Google Fonts, Monaco (workers from blob:), and frames
 * apps on other origins plus blob:/srcdoc previews, so an enforced policy
 * that misses one of them breaks the app for everyone. Report-only puts the
 * violations in the browser console (and nothing is blocked), which is how
 * this baseline gets tightened before it is enforced.
 *
 * `CONTENT_SECURITY_POLICY_MODE`: `report-only` (default), `enforce`, `off`.
 *
 * Only `text/html` responses get it, and never one that already carries a
 * policy of its own (app hosts, sandboxed documents, thumbnails).
 */
export const SPA_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' blob: https://www.googletagmanager.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data: https:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
].join("; ");

type CspMode = "report-only" | "enforce" | "off";

export function cspMode(): CspMode {
  const mode = process.env.CONTENT_SECURITY_POLICY_MODE;
  return mode === "enforce" || mode === "off" ? mode : "report-only";
}

export async function spaCspMiddleware(c: Context, next: Next) {
  await next();
  const mode = cspMode();
  if (mode === "off") return;
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/html")) return;
  if (
    c.res.headers.has("content-security-policy") ||
    c.res.headers.has("content-security-policy-report-only")
  ) {
    return;
  }
  try {
    c.res.headers.set(
      mode === "enforce"
        ? "Content-Security-Policy"
        : "Content-Security-Policy-Report-Only",
      SPA_CONTENT_SECURITY_POLICY,
    );
  } catch {
    // Immutable headers (a proxied upstream response): leave it as it is.
  }
}
