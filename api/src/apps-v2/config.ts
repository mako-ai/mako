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

/** Default and ceiling for sandbox command execution time. */
export const APPS_V2_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const APPS_V2_EXEC_MAX_TIMEOUT_MS = 600_000;

/** Cap on captured stdout/stderr per command (each). */
export const APPS_V2_EXEC_MAX_OUTPUT_BYTES = 1_000_000;

/** Cap on a single file written through the worktree API. */
export const APPS_V2_MAX_FILE_BYTES = 5_000_000;
