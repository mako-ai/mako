/**
 * Apps v2 configuration (see apps-v2.md at the repo root).
 *
 * Apps v2 is the git-backed apps module: the customer's linked GitHub repo is
 * the durable store, an E2B sandbox is the ephemeral working copy, and the
 * agent has a real shell. It runs in parallel with apps v1 and is always
 * available (no feature flag).
 */
import os from "node:os";
import path from "node:path";

/** Root directory holding the bare git repos (one per app project). */
export function appsV2ReposRoot(): string {
  return (
    process.env.APPS_V2_GIT_ROOT ||
    path.join(os.homedir(), ".mako", "apps-v2", "repos")
  );
}

/** Root directory holding materialized session working trees. */
export function appsV2SessionsRoot(): string {
  return (
    process.env.APPS_V2_SESSIONS_ROOT ||
    path.join(os.homedir(), ".mako", "apps-v2", "sessions")
  );
}

export type AppsV2SandboxProviderId = "local" | "e2b";

/**
 * Which sandbox provider executes shell commands.
 *
 * - "local": commands run as subprocesses of the API host inside the session
 *   directory with an allowlisted environment. This is a DEVELOPMENT provider
 *   (single-tenant VMs, local dev). It intentionally refuses to activate in
 *   production, where tenant code must never run on the API host (RFC N1).
 * - "e2b": Firecracker microVM provider — the production target, implemented
 *   behind the same seam in a later phase.
 */
export function appsV2SandboxProviderId(): AppsV2SandboxProviderId {
  const configured = (process.env.APPS_V2_SANDBOX_PROVIDER ?? "").trim();
  if (configured === "local" || configured === "e2b") return configured;
  if (configured) {
    throw new Error(
      `Unknown APPS_V2_SANDBOX_PROVIDER "${configured}" (expected "local" or "e2b")`,
    );
  }
  // Default: local outside production, unconfigured (error on use) in prod.
  if (process.env.NODE_ENV !== "production") return "local";
  throw new Error(
    "Apps v2 sandbox provider is not configured. Set APPS_V2_SANDBOX_PROVIDER.",
  );
}

/** Default and ceiling for sandbox command execution time. */
export const APPS_V2_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const APPS_V2_EXEC_MAX_TIMEOUT_MS = 600_000;

/** Cap on captured stdout/stderr per command (each). */
export const APPS_V2_EXEC_MAX_OUTPUT_BYTES = 1_000_000;

/** Cap on a single file written through the worktree API. */
export const APPS_V2_MAX_FILE_BYTES = 5_000_000;
