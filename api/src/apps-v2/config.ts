/**
 * Apps v2 configuration (see apps-v2.md at the repo root).
 *
 * Apps v2 is the git-backed apps module: the customer's linked GitHub repo is
 * the durable store, an E2B sandbox is the ephemeral working copy, and the
 * agent has a real shell. It runs in parallel with apps v1 and is always
 * available (no feature flag).
 */
import fsSync from "node:fs";
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

/**
 * Where a build's `dist/` is staged so the static preview server can read it.
 *
 * The API keeps no working copy of an app any more — the sandbox holds that.
 * This is the one narrow exception: built bytes are not in git, and the
 * preview server serves from disk. One directory per project, overwritten by
 * the next build, owned by nothing else.
 */
export function previewStagingDir(projectId: string): string {
  return path.join(appsV2SessionsRoot(), "preview", projectId);
}

/**
 * Base URL the SANDBOX uses to reach this API — specifically, its git remote.
 *
 * Separate from BASE_URL because they answer different questions. BASE_URL is
 * where a browser reaches Mako; this is where a microVM does, and in local
 * development those are not the same address: `http://localhost:8080` means
 * the sandbox itself, and resolves to nothing.
 *
 * Deployed, BASE_URL is already public and this needs no setting. Developing
 * against E2B, point it at a tunnel to your API. Developing against the local
 * provider, BASE_URL is correct as-is, since "the sandbox" is this machine.
 */
function tunnelUrl(): string | undefined {
  // Read from disk on each call, deliberately. `pnpm dev` starts the tunnel
  // alongside the API, so the URL does not exist yet when the API boots and
  // an env var read at startup would be empty for the whole session. It is
  // read when a sandbox actually needs a remote, which is late enough.
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    const file = fsSync.readFileSync(
      path.join(process.cwd(), "..", ".env.tunnel"),
      "utf8",
    );
    return (
      /^APPS_V2_GIT_ORIGIN_URL=(.+)$/m.exec(file)?.[1]?.trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function appsV2GitOriginBase(): string {
  const base =
    process.env.APPS_V2_GIT_ORIGIN_URL || tunnelUrl() || process.env.BASE_URL;
  if (!base) {
    throw new Error(
      "Set APPS_V2_GIT_ORIGIN_URL (or BASE_URL) so the sandbox has a git remote to push to.",
    );
  }
  return base.replace(/\/+$/, "");
}

/** The workspace repository's URL, as the sandbox addresses it. */
export function appsV2GitOriginUrl(workspaceId: string): string {
  return `${appsV2GitOriginBase()}/api/apps-v2-git/${workspaceId}.git`;
}
