/**
 * Apps configuration (see apps.md at the repo root).
 *
 * Apps is the git-backed apps module: the customer's linked GitHub repo is
 * the durable store, an E2B sandbox is the ephemeral working copy, and the
 * agent has a real shell. Always available (no feature flag beyond the UI
 * rail toggle).
 */
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

function appsEnv(name: string): string | undefined {
  return process.env[`APPS_${name}`];
}

/**
 * Default on-disk root, honouring data written under the pre-rename default.
 * Existing deployments hold bare repos under `~/.mako/apps-v2/...`; pointing
 * a renamed default at an empty directory would orphan every workspace repo,
 * so the old directory wins whenever it exists and the new one does not.
 */
function defaultRoot(leaf: string): string {
  const next = path.join(os.homedir(), ".mako", "apps", leaf);
  const legacy = path.join(os.homedir(), ".mako", "apps-v2", leaf);
  if (!fsSync.existsSync(next) && fsSync.existsSync(legacy)) return legacy;
  return next;
}

/** Root directory holding the bare git repos (one per app project). */
export function appsReposRoot(): string {
  return appsEnv("GIT_ROOT") || defaultRoot("repos");
}

/** Root directory holding materialized session working trees. */
export function appsSessionsRoot(): string {
  return appsEnv("SESSIONS_ROOT") || defaultRoot("sessions");
}

/** The configured sandbox provider (undefined = provider default). */
export function appsSandboxProviderEnv(): string | undefined {
  return appsEnv("SANDBOX_PROVIDER");
}

/** The configured E2B template alias (undefined = E2B stock "base"). */
export function appsE2BTemplateEnv(): string | undefined {
  return appsEnv("E2B_TEMPLATE");
}

/** Opt-in for mirror pushes to customer-connected repos. */
export function appsConnectedRepoPushEnv(): string | undefined {
  return appsEnv("CONNECTED_REPO_PUSH");
}

/**
 * Production: a workspace must connect its own GitHub repository before
 * anything is saved to git — there is no Mako-hosted tier (apps.md §17).
 * Unset (dev, previews, tests) = local bare repos, nothing durable.
 */
export function appsRequireConnectedRepo(): boolean {
  return appsEnv("REQUIRE_CONNECTED_REPO") === "true";
}

/** Thrown by write paths when the gate above is on and no repo is bound. */
export class RepoRequiredError extends Error {
  readonly status = 412;
  readonly code = "github_required";
  constructor() {
    super(
      "Connect a GitHub repository first (Settings → GitHub). Mako keeps your workspace content — apps, consoles, dbt, prompt — in your own repo.",
    );
    this.name = "RepoRequiredError";
  }
}

export type AppsSandboxProviderId = "local" | "e2b";

/** Default and ceiling for sandbox command execution time. */
export const APPS_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const APPS_EXEC_MAX_TIMEOUT_MS = 600_000;

/** Cap on captured stdout/stderr per command (each). */
export const APPS_EXEC_MAX_OUTPUT_BYTES = 1_000_000;

/** Cap on a single file written through the worktree API. */
export const APPS_MAX_FILE_BYTES = 5_000_000;

/**
 * Where a build's `dist/` is staged so the static preview server can read it.
 *
 * The API keeps no working copy of an app any more — the sandbox holds that.
 * This is the one narrow exception: built bytes are not in git, and the
 * preview server serves from disk. One directory per project, overwritten by
 * the next build, owned by nothing else.
 */
export function previewStagingDir(projectId: string): string {
  return path.join(appsSessionsRoot(), "preview", projectId);
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
      /^APPS_(?:V2_)?GIT_ORIGIN_URL=(.+)$/m.exec(file)?.[1]?.trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function appsGitOriginBase(): string {
  const base = appsEnv("GIT_ORIGIN_URL") || tunnelUrl() || process.env.BASE_URL;
  if (!base) {
    throw new Error(
      "Set APPS_GIT_ORIGIN_URL (or BASE_URL) so the sandbox has a git remote to push to.",
    );
  }
  return base.replace(/\/+$/, "");
}

/** The workspace repository's URL, as the sandbox addresses it. */
export function appsGitOriginUrl(workspaceId: string): string {
  return `${appsGitOriginBase()}/api/apps-git/${workspaceId}.git`;
}
