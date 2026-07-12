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
export const APP_V2_SESSION_MAX_ARG_COUNT = 64;
export const APP_V2_SESSION_MAX_ARG_CHARACTERS = 8_192;
export const APP_V2_SESSION_DEFAULT_TIMEOUT_MS = 60_000;
export const APP_V2_SESSION_MAX_TIMEOUT_MS = 10 * 60 * 1_000;
export const APP_V2_SESSION_MAX_OUTPUT_BYTES = 1024 * 1024;
export const APP_V2_SESSION_CONTROL_PLANE_TIMEOUT_MS = 60_000;
export const APP_V2_SESSION_OPERATION_LEASE_MS = 15 * 60 * 1_000;
export const APP_V2_SESSION_MAX_PACKAGE_COUNT = 32;
export const APP_V2_SESSION_MAX_PACKAGE_SPEC_CHARACTERS = 256;

export function isAppsV2Enabled(): boolean {
  return process.env.APPS_V2_ENABLED === "true";
}

export function validateAppsV2StartupConfiguration(): void {
  if (isAppsV2Enabled()) getAppsV2GitRoot();
}

export type AppsV2SandboxConfiguration =
  | {
      available: true;
      provider: "e2b";
      apiKey: string;
      templateId: string;
      user: string;
    }
  | {
      available: false;
      provider: "off";
      reason: "off" | "unsupported_provider" | "missing_credentials";
    };

export function getAppsV2SandboxConfiguration(): AppsV2SandboxConfiguration {
  const configured = process.env.APPS_V2_SANDBOX_PROVIDER?.trim() || "off";
  if (configured === "off") {
    return { available: false, provider: "off", reason: "off" };
  }
  if (configured !== "e2b") {
    return {
      available: false,
      provider: "off",
      reason: "unsupported_provider",
    };
  }
  const apiKey = process.env.E2B_API_KEY?.trim();
  const templateId = process.env.E2B_TEMPLATE_ID?.trim();
  const user = process.env.APPS_V2_E2B_USER?.trim();
  if (
    !apiKey ||
    !templateId ||
    !user ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)
  ) {
    return {
      available: false,
      provider: "off",
      reason: "missing_credentials",
    };
  }
  return { available: true, provider: "e2b", apiKey, templateId, user };
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
