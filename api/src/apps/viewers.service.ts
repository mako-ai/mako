/**
 * Viewer roles for published apps (apps.md §27).
 *
 * Two layers of authorization, deliberately separate:
 *
 * - WHO MAY OPEN an app is Mongo's decision (utils/resource-acl.ts) and
 *   nothing here touches it.
 * - WHAT A VIEWER SEES once inside — which bindings, which rows, and a
 *   `role` the UI can branch on — is the REPO's decision, declared in
 *   `mako.json` (`viewers`) and in binding front matter (`roles`,
 *   `row_filter_<role>`), read at the published commit. Repo config can only
 *   narrow, never grant: a viewer the ACL does not admit never reaches this
 *   code, and a viewer it does admit but no role claims is refused (fail
 *   closed).
 *
 * Everything in this module is pure so it can be tested without git or
 * Mongo; `loadViewersConfig` is the one function that reads the repo.
 */
import { z } from "zod";
import type { IAppProject } from "../database/workspace-schema";
import { readFile } from "./worktree.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-viewers");

/** Role names double as front-matter key suffixes (`row_filter_<role>`), and
 * front-matter keys are lowercased on parse — so roles are lowercase too. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9_]*$/;
/** Claim names appear in `{{ viewer.<claim> }}` placeholders. */
export const CLAIM_NAME_RE = /^[a-z_][a-z0-9_]*$/;
/** Claims the platform always supplies; a manifest may not redefine them. */
const BUILTIN_CLAIMS = new Set(["email", "role"]);

export type ViewerClaims = Record<string, string>;

export interface ViewerRole {
  name: string;
  /** Lowercased email → extra claims for that member. */
  members: Map<string, ViewerClaims>;
}

export interface ViewersConfig {
  /** Role for an admitted viewer no role lists. Absent = refuse them. */
  defaultRole?: string;
  /** Declaration order: the first role listing a viewer wins. */
  roles: ViewerRole[];
}

/** What the serving layer knows about the person behind the request. */
export interface ViewerIdentity {
  id?: string;
  email: string;
}

/** The viewer as the app sees it (`__data/viewer.json`). */
export interface ResolvedViewer {
  email: string;
  role: string;
  /** Always includes `email` and `role`, plus the member's own claims. */
  claims: ViewerClaims;
}

const ClaimValue = z.union([z.string(), z.number(), z.boolean()]);
const RoleSchema = z.strictObject({
  members: z.record(z.string(), z.record(z.string(), ClaimValue)).optional(),
});
const ViewersSchema = z.strictObject({
  default: z.string().optional(),
  roles: z.record(z.string(), RoleSchema),
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invalid(message: string): Error {
  return new Error(`mako.json "viewers" is invalid: ${message}`);
}

/**
 * Parse the `viewers` block of a manifest. Returns null when the manifest
 * has none (the app is not role-scoped); throws on a block that is present
 * but malformed — a builder-facing message, since only a commit can fix it.
 */
export function parseViewersConfig(manifest: unknown): ViewersConfig | null {
  if (!manifest || typeof manifest !== "object") return null;
  const raw = (manifest as { viewers?: unknown }).viewers;
  if (raw === undefined || raw === null) return null;
  const parsed = ViewersSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues
        .map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  const roles: ViewerRole[] = [];
  for (const [name, role] of Object.entries(parsed.data.roles)) {
    if (!ROLE_NAME_RE.test(name)) {
      throw invalid(
        `role "${name}" must be lowercase letters, digits and underscores`,
      );
    }
    const members = new Map<string, ViewerClaims>();
    for (const [email, claims] of Object.entries(role.members ?? {})) {
      const key = normalizeEmail(email);
      if (!key.includes("@")) {
        throw invalid(`role "${name}": member "${email}" is not an email`);
      }
      const out: ViewerClaims = {};
      for (const [claim, value] of Object.entries(claims)) {
        if (!CLAIM_NAME_RE.test(claim)) {
          throw invalid(
            `role "${name}", member "${email}": claim "${claim}" must be lowercase letters, digits and underscores`,
          );
        }
        if (BUILTIN_CLAIMS.has(claim)) {
          throw invalid(
            `role "${name}", member "${email}": "${claim}" is a built-in claim`,
          );
        }
        out[claim] = String(value);
      }
      members.set(key, out);
    }
    roles.push({ name, members });
  }
  if (roles.length === 0) {
    throw invalid("roles must declare at least one role");
  }
  const defaultRole = parsed.data.default;
  if (defaultRole !== undefined && !roles.some(r => r.name === defaultRole)) {
    throw invalid(`default role "${defaultRole}" is not declared in roles`);
  }
  return { defaultRole, roles };
}

/**
 * The viewer's role and claims under this config, or null when the config
 * does not admit them (no role lists them and there is no default).
 */
export function resolveViewer(
  config: ViewersConfig,
  viewer: ViewerIdentity,
): ResolvedViewer | null {
  const email = normalizeEmail(viewer.email);
  for (const role of config.roles) {
    const claims = role.members.get(email);
    if (claims) {
      return {
        email,
        role: role.name,
        claims: { ...claims, email, role: role.name },
      };
    }
  }
  if (config.defaultRole) {
    return {
      email,
      role: config.defaultRole,
      claims: { email, role: config.defaultRole },
    };
  }
  return null;
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

export function bindingVisibleTo(policy: BindingPolicy, role: string): boolean {
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

// ---------------------------------------------------------------------------
// Repo access.
// ---------------------------------------------------------------------------

/**
 * The app's viewers config as of `at` (published serving) or the actor's
 * view (builder preview). null = the app is not role-scoped. A manifest
 * that is not JSON at all is treated as absent — it never blocked serving
 * before, and readBindings tolerates it the same way — but a PRESENT
 * `viewers` block that is malformed throws, so a role-scoped app fails
 * closed rather than open.
 */
export async function loadViewersConfig(
  project: IAppProject,
  actorId: string,
  at?: string,
): Promise<ViewersConfig | null> {
  let contents: string;
  try {
    contents = (await readFile(project, "mako.json", actorId, at)).contents;
  } catch {
    return null;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    logger.warn(
      "mako.json is not valid JSON; treating the app as not role-scoped",
      {
        projectId: project._id?.toString(),
        at,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
  return parseViewersConfig(manifest);
}
