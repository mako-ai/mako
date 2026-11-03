/**
 * dbt RBAC policy — pure, testable access decisions for the Transforms module.
 *
 * Reads/lists (GET) are open to any member incl. viewer; viewers are otherwise
 * read-only. Members may only VALIDATE: compile, preview (dbt show of an
 * existing model), read-only console commands (checked in the route) and
 * their own dev-environment preference. Everything else that writes — dbt
 * files, projects, environments, jobs, job triggers, run cancel/retry, local
 * (CLI) runs, warehouse-writing commands — requires admin or owner.
 * 2026-10-30: "members shouldn't touch dbt"; before that every non-GET was
 * member+ except deployment config.
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

/**
 * The only non-GET routes a member may call. Everything else that is not a
 * GET is admin+. `/command` is listed because the route itself refuses a
 * warehouse-writing command for a member (isWarehouseWriteCommand).
 */
export const DBT_MEMBER_WRITES: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /\/dbt\/projects\/[^/]+\/compile$/ },
  { method: "POST", pattern: /\/dbt\/projects\/[^/]+\/preview$/ },
  { method: "POST", pattern: /\/dbt\/projects\/[^/]+\/command$/ },
  { method: "PUT", pattern: /\/dbt\/projects\/[^/]+\/my-environment$/ },
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

  // DBT_ADMIN_ONLY stays as documentation of deployment config; the rule is
  // now allowlist-shaped: any write not in DBT_MEMBER_WRITES is admin+.
  const memberWrite = DBT_MEMBER_WRITES.some(
    rule => rule.method === method && rule.pattern.test(path),
  );
  if (!memberWrite && role !== "owner" && role !== "admin") {
    return {
      ok: false,
      status: 403,
      error:
        "Changing or running dbt requires the admin or owner workspace role",
    };
  }

  return ALLOW;
}

/** Owners and admins change and run dbt; everyone else only validates. */
export function isDbtAdminRole(role: string | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whose working tree an ad-hoc parse/compile/show builds. Owners and admins
 * build their own (checkout branch + drafts). Everyone else builds the
 * project's tracked branch as committed: a member validates committed
 * models, never drafts or another ref (Joan, 2026-10-30). `undefined` means
 * the committed base tree.
 */
export function dbtWorkingTreeUserFor(
  role: string | undefined | null,
  userId: string | undefined,
): string | undefined {
  return isDbtAdminRole(role) ? userId : undefined;
}
