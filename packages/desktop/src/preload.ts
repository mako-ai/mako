/**
 * Preload bridge: lets the web app detect it is running inside Mako Desktop
 * (e.g. to skip the Local Network Access permission hint, or to show
 * desktop-specific UI).
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("makoDesktop", {
  version: process.env.npm_package_version || "0.1.0",
  platform: process.platform,
});
