/**
 * Graceful rename — the contract every object kind implements.
 *
 * One rule for every kind: a rename never breaks what pointed at the old
 * name. Each kind records its previous names (`aliases`) WITH the object —
 * in its own file when it is git-backed (`mako.json`, a flow or job YAML,
 * a skill's front matter, a connector's `connector.yaml`), on its row when
 * it lives only in the database — so the record travels with every clone,
 * branch and laptop `git mv`. Lookups try the current name first and an
 * alias only when nothing current claims the ref; an alias claimed by two
 * objects resolves to neither (an ambiguous old link must not silently open
 * the wrong thing).
 *
 * Kinds whose FILE NAME is their identity (flows, dbt jobs, skills,
 * workspace connectors) are re-keyed in place on rename: same row, same id,
 * same checkpoints/history/webhook — never a teardown plus a create.
 *
 * Handlers live in `./handlers/<kind>.ts` and are listed in `./registry.ts`.
 * The agent/MCP tool `rename_object` and `GET /links/resolve` dispatch here;
 * the UI keeps its per-kind routes, which call the same services.
 */

export const RENAME_KINDS = [
  "app",
  "console",
  "notebook",
  "dashboard",
  "flow",
  "dbt_file",
  "dbt_job",
  "skill",
  "connector",
  "connection",
] as const;

export type RenameKind = (typeof RENAME_KINDS)[number];

export interface RenameContext {
  workspaceId: string;
  /** Absent for a workspace API key with no user behind it. */
  userId?: string;
  /** The caller's live workspace role (owner/admin/member/viewer), if any. */
  role?: string;
}

export interface RenameRequest {
  /** Id, current name/slug/path, or an alias — whatever the kind accepts. */
  ref: string;
  /**
   * New display name (title). Kinds without a separate display name treat
   * this as the new name of the object itself.
   */
  title?: string;
  /**
   * New identifier: app folder slug, flow/job/connector slug, skill name,
   * dbt file path (repo-relative under `dbt/`), console/notebook file name.
   * The old one becomes an alias.
   */
  slug?: string;
  /** Kind-specific options (e.g. dbt `updateRefs`). Unknown keys ignored. */
  options?: Record<string, unknown>;
}

/** Where an object is, as a person or a link sees it. */
export interface RenameLocation {
  /** Display name. */
  title?: string;
  /** The identifier the kind is addressed by (slug, name, repo path). */
  slug?: string;
  /** Repo path for git-backed kinds. */
  path?: string;
  /** In-app URL path, e.g. `/apps/traffic-performance` (no origin). */
  url?: string;
}

export interface RenameResult {
  kind: RenameKind;
  /** Stable id — unchanged by the rename. */
  id: string;
  before: RenameLocation;
  after: RenameLocation;
  /** Previous names now recorded as aliases by this rename. */
  aliasesAdded: string[];
  /** Commit sha on main when the rename was a git commit. */
  commit?: string;
  /** Things the caller must know (e.g. "3 consoles still query the old table"). */
  warnings: string[];
}

export interface ResolvedRef {
  kind: RenameKind;
  id: string;
  /** `current`: the ref names the object today; `alias`: an old name. */
  via: "current" | "alias";
  current: RenameLocation;
}

export interface RenameHandler {
  kind: RenameKind;
  /** One line for the tool description: what `title`/`slug` mean here. */
  describe: string;
  /** Resolve a ref (id, current name, or alias). `null` when nothing (or more than one object) claims it. */
  resolve(ctx: RenameContext, ref: string): Promise<ResolvedRef | null>;
  /** Apply the rename. Throws `RenameError` for user-facing failures. */
  rename(ctx: RenameContext, request: RenameRequest): Promise<RenameResult>;
}

/** A failure the caller should show as-is (bad name, taken, no permission). */
export class RenameError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 412 = 400,
  ) {
    super(message);
    this.name = "RenameError";
  }
}
