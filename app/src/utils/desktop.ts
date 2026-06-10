/**
 * Mako Desktop (Electron shell) detection and bridge helpers.
 *
 * The desktop preload script (packages/desktop/src/preload.ts) exposes
 * `window.makoDesktop` via contextBridge. The web app uses it to adapt UI
 * (e.g. route OAuth logins through the system browser instead of the
 * embedded Chromium window).
 */

export interface MakoDesktopBridge {
  version: string;
  platform: string;
  /**
   * Ask the desktop main process to start the browser-based sign-in flow:
   * it generates a PKCE pair and opens the system browser at
   * /desktop-auth?challenge=<S256(verifier)>.
   * Optional because older desktop builds may not expose it.
   */
  startBrowserAuth?: () => Promise<void>;
}

declare global {
  interface Window {
    makoDesktop?: MakoDesktopBridge;
  }
}

/** True when the web app is running inside the Mako Desktop Electron shell. */
export function isMakoDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.makoDesktop);
}

/**
 * True when the desktop shell supports the browser-based sign-in handoff.
 */
export function supportsDesktopBrowserAuth(): boolean {
  return (
    isMakoDesktop() &&
    typeof window.makoDesktop?.startBrowserAuth === "function"
  );
}

/**
 * Start the browser-based sign-in flow from inside the desktop shell.
 * Resolves once the system browser has been opened.
 */
export async function startDesktopBrowserAuth(): Promise<void> {
  await window.makoDesktop?.startBrowserAuth?.();
}
