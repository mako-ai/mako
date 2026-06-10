/**
 * Mako Desktop download links.
 *
 * Asset names are stable across releases (configured in
 * packages/desktop/electron-builder.yml), so the GitHub "latest" release
 * redirect gives us evergreen URLs that always serve the newest version.
 */
const RELEASE_BASE = "https://github.com/mako-ai/mako/releases/latest/download";

export type DesktopPlatformId =
  | "mac-arm64"
  | "mac-x64"
  | "win-x64"
  | "linux-x64";

export interface DesktopDownload {
  id: DesktopPlatformId;
  label: string;
  shortLabel: string;
  url: string;
  fileType: string;
}

export const DESKTOP_DOWNLOADS: DesktopDownload[] = [
  {
    id: "mac-arm64",
    label: "macOS (Apple Silicon)",
    shortLabel: "macOS",
    url: `${RELEASE_BASE}/Mako-mac-arm64.dmg`,
    fileType: ".dmg",
  },
  {
    id: "mac-x64",
    label: "macOS (Intel)",
    shortLabel: "macOS (Intel)",
    url: `${RELEASE_BASE}/Mako-mac-x64.dmg`,
    fileType: ".dmg",
  },
  {
    id: "win-x64",
    label: "Windows",
    shortLabel: "Windows",
    url: `${RELEASE_BASE}/Mako-win-x64.exe`,
    fileType: ".exe",
  },
  {
    id: "linux-x64",
    label: "Linux",
    shortLabel: "Linux",
    url: `${RELEASE_BASE}/Mako-linux-x86_64.AppImage`,
    fileType: ".AppImage",
  },
];

export const ALL_RELEASES_URL = "https://github.com/mako-ai/mako/releases";

export function getDownload(id: DesktopPlatformId): DesktopDownload {
  const download = DESKTOP_DOWNLOADS.find(d => d.id === id);
  if (!download) throw new Error(`Unknown platform: ${id}`);
  return download;
}

interface UserAgentDataLike {
  platform?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string }>;
}

/**
 * Best-effort client platform detection. Chromium exposes architecture via
 * User-Agent Client Hints; Safari does not, so Apple Silicon is the default
 * for macOS (the overwhelming majority of Macs in use) with the Intel build
 * offered as an alternate link in the UI.
 */
export async function detectPlatform(): Promise<DesktopPlatformId> {
  if (typeof navigator === "undefined") return "mac-arm64";

  const uaData = (
    navigator as Navigator & { userAgentData?: UserAgentDataLike }
  ).userAgentData;
  const platform = (
    uaData?.platform ||
    navigator.platform ||
    navigator.userAgent
  ).toLowerCase();

  if (platform.includes("win")) return "win-x64";
  if (platform.includes("linux") && !platform.includes("android")) {
    return "linux-x64";
  }
  if (platform.includes("mac")) {
    try {
      const high = await uaData?.getHighEntropyValues?.(["architecture"]);
      if (high?.architecture === "x86") return "mac-x64";
    } catch {
      // Client hints unavailable (e.g. Safari) — fall through to arm64.
    }
    return "mac-arm64";
  }
  // Mobile or unknown: default to the most common desktop platform.
  return "mac-arm64";
}
