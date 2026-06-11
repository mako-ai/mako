/**
 * Preload bridge: lets the web app detect it is running inside Mako Desktop
 * (e.g. to skip the Local Network Access permission hint, or to show
 * desktop-specific UI) and start the browser-based sign-in handoff.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("makoDesktop", {
  version: process.env.npm_package_version || "0.1.0",
  platform: process.platform,
  /**
   * Ask the main process to open the system browser at /desktop-auth with a
   * fresh PKCE challenge. The session comes back via a mako:// deep link.
   */
  startBrowserAuth: (): Promise<void> =>
    ipcRenderer.invoke("mako:start-browser-auth"),
});
