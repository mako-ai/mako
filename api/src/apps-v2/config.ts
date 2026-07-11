import os from "node:os";
import path from "node:path";

export const APP_V2_MAX_FILE_BYTES = 1024 * 1024;
export const APP_V2_MAX_FILES = 1_000;
export const APP_V2_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const APP_V2_MAX_REQUEST_BYTES = APP_V2_MAX_FILE_BYTES + 64 * 1024;
export const APP_V2_GIT_TIMEOUT_MS = 15_000;
export const APP_V2_GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const APP_V2_GIT_MAX_CONCURRENCY = 8;
export const APP_V2_DEFAULT_MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;

export function isAppsV2Enabled(): boolean {
  return process.env.APPS_V2_ENABLED === "true";
}

export function validateAppsV2StartupConfiguration(): void {
  if (isAppsV2Enabled()) getAppsV2GitRoot();
}

export function getAppsV2MaxRepositoryBytes(): number {
  const raw = process.env.APPS_V2_MAX_REPOSITORY_BYTES?.trim();
  if (!raw) return APP_V2_DEFAULT_MAX_REPOSITORY_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("APPS_V2_MAX_REPOSITORY_BYTES must be a positive integer");
  }
  return value;
}

export function getAppsV2GitRoot(): string {
  const configured = process.env.APPS_V2_GIT_ROOT?.trim();
  const productionRuntime =
    process.env.NODE_ENV === "production" || Boolean(process.env.K_SERVICE);
  if (productionRuntime) {
    if (process.env.APPS_V2_GIT_DURABILITY_CONFIRMED !== "true") {
      throw new Error(
        "APPS_V2_GIT_DURABILITY_CONFIRMED=true is required in production",
      );
    }
    if (!configured) {
      throw new Error("APPS_V2_GIT_ROOT is required in production");
    }
    if (!path.isAbsolute(configured)) {
      throw new Error("APPS_V2_GIT_ROOT must be an absolute production path");
    }
    const normalizedRoot = path.resolve(configured);
    const temporaryRoot = path.resolve(os.tmpdir());
    const relativeToTemporary = path.relative(temporaryRoot, normalizedRoot);
    if (
      relativeToTemporary === "" ||
      (!relativeToTemporary.startsWith("..") &&
        !path.isAbsolute(relativeToTemporary))
    ) {
      throw new Error("APPS_V2_GIT_ROOT may not use temporary storage");
    }
    return normalizedRoot;
  }
  if (configured) return path.resolve(configured);
  return path.join("/tmp", "mako-apps-v2-git");
}
