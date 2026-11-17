/**
 * The Vite `allowedHosts` entry a dev-server preview needs, read from the
 * preview URL itself: `https://5173-<sandboxId>.e2b-juliett.dev` gives
 * `.e2b-juliett.dev`. The E2B domain is per region, so the client never
 * hardcodes it. Falls back to `.e2b.app` when the URL has no sandbox label.
 */
export function previewHostSuffix(url: string | undefined | null): string {
  try {
    const host = new URL(url ?? "").hostname;
    const dot = host.indexOf(".");
    if (dot > 0 && host.indexOf(".", dot + 1) > dot) return host.slice(dot);
  } catch {
    // Not a URL: fall through to the default.
  }
  return ".e2b.app";
}
