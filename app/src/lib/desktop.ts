/**
 * Detection for the Mako Desktop (Electron) shell. The desktop preload script
 * exposes `window.makoDesktop`; the Electron UA token is stripped for OAuth
 * compatibility, so user-agent sniffing does not work.
 */

declare global {
  interface Window {
    makoDesktop?: {
      version: string;
      platform: string;
    };
  }
}

export function isMakoDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.makoDesktop);
}
