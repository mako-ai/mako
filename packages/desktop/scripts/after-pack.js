/**
 * electron-builder afterPack hook.
 *
 * When no Developer ID certificate is available (e.g. CI without signing
 * secrets), electron-builder skips macOS signing entirely. A completely
 * unsigned app triggers Gatekeeper's unrecoverable "Mako is damaged" dialog
 * (and won't load at all on Apple Silicon). Ad-hoc signing downgrades that
 * to the recoverable "could not verify" flow (System Settings -> Privacy &
 * Security -> Open Anyway, or xattr -dr com.apple.quarantine).
 *
 * No-op when a real identity is configured (CSC_LINK set) — electron-builder
 * then signs and notarizes properly and we must not overwrite it.
 */
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`afterPack: ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
  execSync(`codesign --verify --verbose "${appPath}"`, { stdio: "inherit" });
};
