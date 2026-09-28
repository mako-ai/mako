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
  /**
   * Re-fetch a cached parquet after this long (ms). Default: 5 minutes. A
   * cache built from different binding text (or dbt environment) is never
   * served, whatever this says — `Infinity` is safe while you edit SQL.
   */
  revalidateMs?: number;
  /**
   * Build bindings through the API: the local `bindings/<name>.sql` text
   * (uncommitted edits included), or the committed binding when it was never
   * materialized. `false` serves committed artifacts only. Default: true.
   */
  materialize?: boolean;
  /**
   * Render `{{ dbt_schema }}` in dbt-linked bindings against this dbt
   * environment (e.g. your personal one, `dbt_<you>`) instead of production.
   * Those builds are yours alone — never stored as the app's data. Default:
   * MAKO_DBT_ENV, else production.
   */
  dbtEnvironment?: string;
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
  /** dbt environment for `{{ dbt_schema }}`, or "" for production. */
  dbtEnvironment: string;
}

/** Resolve credentials and identity the way `makoData` does. */
export function resolveMakoContext(
  appDir: string,
  options?: MakoDataOptions,
): MakoContext;

/**
 * What a cached parquet was built from: a hash of the binding file's text and
 * the dbt environment. The plugin serves a cache entry only for a match.
 */
/** CRLF/CR → LF and no trailing whitespace — what bindingFingerprint hashes. */
export function normalizeBindingSource(source: string): string;

export function bindingFingerprint(source: string, dbtEnvironment?: string): string;

/**
 * Serve the app's data bindings (`__data/index.json`, `__data/<name>.parquet`)
 * during a local `vite dev`, built by Mako from the local binding files.
 */
export function makoData(options?: MakoDataOptions): Plugin;
export default makoData;
