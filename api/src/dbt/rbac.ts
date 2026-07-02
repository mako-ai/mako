/**
 * dbt RBAC policy — pure, testable access decisions for the Transforms module.
 *
 * Reads/lists (GET) are open to any member incl. viewer; viewers are otherwise
 * read-only. Deployment-config mutations (project create/delete/settings incl.
 * protected branches, repo connect/import, job create/edit/delete) and PR
 * merges require admin+. All other writes — files (per-user drafts), git
 * commit/branch/switch/PR-open on the caller's own checkout, ad-hoc
 * compile/run, run trigger/cancel/retry, repo sync — are member+. Protected
 * branches (PR-only) are enforced separately in the git service.
 */

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/**
 * GET routes that discover GitHub data (private repo/branch names an
 * installation can access). These are not plain reads of workspace data, so
 * they require at least member access — viewers are excluded.
 */
export const DBT_MEMBER_ONLY_GET: RegExp[] = [
  /\/dbt\/github\/repos$/,
  /\/dbt\/github\/branches$/,
  /\/dbt\/github\/repo-check$/,
];

/** Method + path-pattern pairs that require the admin or owner role. */
export const DBT_ADMIN_ONLY: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /\/dbt\/projects$/ },
  { method: "POST", pattern: /\/dbt\/projects\/import-github$/ },
  { method: "PATCH", pattern: /\/dbt\/projects\/[^/]+$/ },
  { method: "DELETE", pattern: /\/dbt\/projects\/[^/]+$/ },
  { method: "POST", pattern: /\/dbt\/projects\/[^/]+\/jobs$/ },
  { method: "PATCH", pattern: /\/dbt\/projects\/[^/]+\/jobs\/[^/]+$/ },
  { method: "DELETE", pattern: /\/dbt\/projects\/[^/]+\/jobs\/[^/]+$/ },
  // Merging a PR is the only write path into protected branches — admin+.
  // Other git actions (commit/branch/switch/PR-open) operate on the caller's
  // OWN checkout + drafts and are member+; protected branches are enforced
  // in the git service regardless of role.
  {
    method: "POST",
    pattern: /\/dbt\/projects\/[^/]+\/git\/merge-pull-request$/,
  },
  {
    method: "PATCH",
    pattern: /\/dbt\/projects\/[^/]+\/git\/pull-request\/\d+$/,
  },
  {
    method: "POST",
    pattern: /\/dbt\/projects\/[^/]+\/git\/pull-request\/\d+\/close$/,
  },
];

export interface DbtAccessDecision {
  ok: boolean;
  /** HTTP status to respond with when `ok` is false. */
  status?: 403;
  error?: string;
}

const ALLOW: DbtAccessDecision = { ok: true };

/**
 * Decide whether a caller with `role` may perform `method` on `path`.
 * Pure: no Hono/context coupling so it can be unit-tested directly.
 */
export function resolveDbtAccess(input: {
  method: string;
  path: string;
  role: string | undefined;
}): DbtAccessDecision {
  const { method, path, role } = input;

  // Reads are open to any member (incl. viewer) — except GitHub discovery
  // routes, which expose private repo/branch names and require member+.
  if (method === "GET") {
    if (DBT_MEMBER_ONLY_GET.some(pattern => pattern.test(path))) {
      if (!role || role === "viewer") {
        return {
          ok: false,
          status: 403,
          error: "Connecting GitHub requires at least member workspace access",
        };
      }
    }
    return ALLOW;
  }

  if (!role) {
    return { ok: false, status: 403, error: "Workspace role not determined" };
  }
  if (role === "viewer") {
    return {
      ok: false,
      status: 403,
      error: "Viewers have read-only access to Transforms",
    };
  }

  const adminOnly = DBT_ADMIN_ONLY.some(
    rule => rule.method === method && rule.pattern.test(path),
  );
  if (adminOnly && role !== "owner" && role !== "admin") {
    return {
      ok: false,
      status: 403,
      error: "This action requires the admin or owner workspace role",
    };
  }

  return ALLOW;
}
