/**
 * Viewer roles for published apps (apps.md §27).
 *
 * Two layers, deliberately separate:
 *
 * - WHO a viewer is comes from their WORKSPACE MEMBERSHIP: the job role and
 *   country an admin set on the Members page (`WorkspaceMember.jobRole` /
 *   `.country`). No list of people lives in any app's repo.
 * - WHAT A ROLE SEES once inside — which bindings, which rows — is the
 *   REPO's decision, declared in binding front matter (`roles`,
 *   `row_filter_<role>`) and read at the published commit. Repo config can
 *   only narrow: a member with no job role reads only unscoped bindings
 *   (fail closed), and so does an anonymous share.
 *
 * Everything here is pure; viewer-resolution.service reads Mongo.
 */
import type { JobRole } from "@mako/schemas";

export type ViewerClaims = Record<string, string>;

/** What the serving layer knows about the person behind the request. */
export interface ViewerIdentity {
  id?: string;
  email: string;
}

/** The viewer as the app sees it (`__data/viewer.json`). */
export interface ResolvedViewer {
  email: string;
  /** The member's job role; null when none is set (or not a member). */
  role: string | null;
  /** `email`, plus `role` and `country` when the membership has them. */
  claims: ViewerClaims;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The viewer a workspace membership (or the lack of one) makes. */
export function viewerFromMember(member: {
  email: string;
  jobRole?: JobRole | string | null;
  country?: string | null;
}): ResolvedViewer {
  const email = normalizeEmail(member.email);
  const role = member.jobRole ? String(member.jobRole) : null;
  const claims: ViewerClaims = { email };
  if (role) claims.role = role;
  if (member.country) claims.country = String(member.country).toUpperCase();
  return { email, role, claims };
}

// ---------------------------------------------------------------------------
// Binding policies — from front matter.
// ---------------------------------------------------------------------------

export interface BindingPolicy {
  /** `-- roles: a, b` — roles that may read the binding at all. null = every role. */
  roles: string[] | null;
  /** `-- row_filter_<role>: <predicate>` — rows a role may read. Absent = all rows. */
  rowFilters: Record<string, string>;
}

const ROW_FILTER_PREFIX = "row_filter_";

export function parseBindingPolicy(
  meta: Record<string, string>,
): BindingPolicy {
  const roles = meta.roles
    ? meta.roles
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    : null;
  const rowFilters: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(ROW_FILTER_PREFIX)) {
      const role = key.slice(ROW_FILTER_PREFIX.length);
      if (role) rowFilters[role] = value.trim();
    }
  }
  return { roles, rowFilters };
}

/** A binding that restricts roles or filters rows for any role. */
export function isScopedPolicy(policy: BindingPolicy): boolean {
  return policy.roles !== null || Object.keys(policy.rowFilters).length > 0;
}

/**
 * May this role read the binding? A scoped binding needs a role: an
 * unassigned member or an anonymous viewer (`null`) reads only bindings
 * that scope nothing. A role that `roles` does not list is out; a role
 * with no row filter of its own gets every row.
 */
export function bindingVisibleTo(
  policy: BindingPolicy,
  role: string | null,
): boolean {
  if (role === null) return !isScopedPolicy(policy);
  return policy.roles === null || policy.roles.includes(role);
}

/** A predicate ready for DuckDB: positional `$n` parameters, values apart. */
export interface CompiledRowFilter {
  sql: string;
  params: string[];
}

const PLACEHOLDER_RE = /\{\{\s*viewer\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Turn `sales_rep_email = {{ viewer.email }}` into `sales_rep_email = $1`
 * with the claim value bound separately — a claim is never spliced into
 * SQL. A placeholder naming a claim the viewer does not have compiles to
 * FALSE: the binding serves its schema and no rows, rather than everything.
 *
 * The predicate text itself is builder-authored (it lives next to the
 * binding's SQL in the repo) and runs only against the already-materialized
 * parquet in an in-memory DuckDB, so the checks here are about shape, not
 * about untrusted input: one expression, no statement separators or
 * comments that could smuggle a second statement into the wrapper.
 */
export function compileRowFilter(
  predicate: string,
  viewer: ResolvedViewer,
): CompiledRowFilter {
  const text = predicate.trim();
  if (!text) throw new Error("row filter is empty");
  if (/;|--|\/\*|\*\//.test(text)) {
    throw new Error(
      "row filter must be a single expression (no `;`, `--` or `/* */`)",
    );
  }
  const params: string[] = [];
  let denied = false;
  const sql = text.replace(PLACEHOLDER_RE, (_m, claim: string) => {
    const value = viewer.claims[claim];
    if (value === undefined) {
      denied = true;
      return "NULL";
    }
    params.push(value);
    return `$${params.length}`;
  });
  if (denied) return { sql: "FALSE", params: [] };
  return { sql, params };
}
