/**
 * Detection and bridge helpers for the Mako Desktop (Electron) shell.
 *
 * The desktop preload script (packages/desktop/src/preload.ts) exposes
 * `window.makoDesktop`; the Electron UA token is stripped, so user-agent
 * sniffing does not work. The web app uses the bridge to adapt UI — e.g.
 * route OAuth logins through the system browser instead of the embedded
 * Chromium window.
 */

export interface MakoDesktopBridge {
  version: string;
  platform: string;
  arch: string;
  /**
   * Ask the desktop main process to start the browser-based sign-in flow:
   * it generates a PKCE pair and opens the system browser at
   * /desktop-auth?challenge=<S256(verifier)>.
   * Optional because older desktop builds may not expose it.
   */
  startBrowserAuth?: () => Promise<void>;
  /**
   * Open system Terminal with Claude/Codex/Cursor CLI login (`codex login`,
   * `cursor-agent login`, etc.).
   * Optional — older Desktop builds lack this; Local Agent may still open Terminal.
   */
  startAcpCliLogin?: (
    providerId: "claude" | "codex" | "cursor",
  ) => Promise<{ opened: boolean; commandLine: string }>;
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

/** True when Desktop can open Terminal for Claude/Codex CLI login. */
export function supportsDesktopAcpCliLogin(): boolean {
  return (
    isMakoDesktop() &&
    typeof window.makoDesktop?.startAcpCliLogin === "function"
  );
}

/**
 * Open Terminal with `codex login` / Claude CLI auth from the Desktop shell.
 * Returns null when not running in a Desktop build that supports it.
 */
export async function startDesktopAcpCliLogin(
  providerId: "claude" | "codex" | "cursor",
): Promise<{ opened: boolean; commandLine: string } | null> {
  const start = window.makoDesktop?.startAcpCliLogin;
  if (!start) return null;
  return (await start(providerId)) ?? null;
}
