/**
 * Preload bridge: lets the web app detect it is running inside Mako Desktop
 * (e.g. to skip the Local Network Access permission hint, or to show
 * desktop-specific UI) and start the browser-based sign-in handoff.
 */
import { contextBridge, ipcRenderer } from "electron";

const metadata = ipcRenderer.sendSync("mako:get-app-metadata") as {
  version: string;
  platform: string;
  arch: string;
};

contextBridge.exposeInMainWorld("makoDesktop", {
  ...metadata,
  /**
   * Ask the main process to open the system browser at /desktop-auth with a
   * fresh PKCE challenge. The session comes back via a mako:// deep link.
   */
  startBrowserAuth: (): Promise<void> =>
    ipcRenderer.invoke("mako:start-browser-auth"),
  /**
   * Open system Terminal with a fixed Claude/Codex CLI login command.
   * Allowlisted in main — not an arbitrary shell.
   */
  startAcpCliLogin: (
    providerId: "claude" | "codex",
  ): Promise<{ opened: boolean; commandLine: string }> =>
    ipcRenderer.invoke("mako:start-acp-cli-login", providerId),
});
