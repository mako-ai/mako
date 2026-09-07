import type { Plugin } from "vite";

export interface MakoDataOptions {
  /** Mako API origin. Default: MAKO_API_URL (process.env, then the repo's .env). */
  apiUrl?: string;
  /** Workspace API key with the query:read scope. Default: MAKO_API_KEY. */
  apiKey?: string;
  /** Default: MAKO_WORKSPACE_ID, then .mako/workspace.json at the repo root. */
  workspaceId?: string;
  /** App slug. Default: the app directory's basename. */
  slug?: string;
  /** Repo root. Default: the nearest ancestor holding .mako/ or .git. */
  repoRoot?: string;
  /** Re-fetch a cached parquet after this long (ms). Default: 5 minutes. */
  revalidateMs?: number;
  /** Build a never-materialized binding on first request. Default: true. */
  materialize?: boolean;
  /**
   * Preview the app as this member (an email): `__data/viewer.json` answers
   * as Mako would for them. Default: MAKO_VIEWER_AS, else yourself.
   */
  viewAs?: string;
}

export interface MakoContext {
  repoRoot: string;
  apiUrl: string;
  apiKey: string;
  workspaceId: string;
  slug: string;
  bindingsDir: string;
  cacheDir: string;
  /** Email of the member being previewed, or "" for yourself. */
  viewAs: string;
}

/** Resolve credentials and identity the way `makoData` does. */
export function resolveMakoContext(
  appDir: string,
  options?: MakoDataOptions,
): MakoContext;

/**
 * Serve the app's data bindings (`__data/index.json`, `__data/<name>.parquet`)
 * during a local `vite dev` by streaming materialized artifacts from Mako.
 */
export function makoData(options?: MakoDataOptions): Plugin;
export default makoData;
