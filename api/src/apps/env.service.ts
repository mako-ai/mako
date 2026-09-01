/**
 * Apps environment variables — the per-app env vault.
 *
 * An app often needs a vendor key the moment it grows past a dashboard: a
 * Google Maps browser key, a Supabase URL + anon key, a PostHog project key.
 * Those belong to the app, not to its git tree — committed keys are painful to
 * rotate and survive forks — so they live here, on the AppProject row, values
 * encrypted at rest with the same crypto.service every other credential uses.
 *
 * One boolean decides where a value may flow, and it encodes the publish
 * model's hard boundary (apps.md §13.4.6 — a published app is a static
 * bundle, there is no server and no runtime env):
 *
 *   secret: false — injected into the sandbox dev server AND the publish
 *     build. A `VITE_`-prefixed var is inlined into the public bundle, which
 *     is exactly right for the publishable-credential class (Maps keys,
 *     Supabase anon keys, Stripe publishable keys — public by design,
 *     protected by referrer restrictions/RLS, not secrecy).
 *
 *   secret: true — injected into sandbox DEV processes only, never into the
 *     publish build, and the `VITE_` prefix is refused outright: Vite inlines
 *     `VITE_*` into the client bundle, so a "secret" with that prefix is a
 *     contradiction we fail loudly rather than ship.
 *
 * Values reach processes as plain env at launch time only — nothing here is
 * ever written into the working tree, committed, or served.
 */
import { Types } from "mongoose";
import {
  AppProject,
  type IAppEnvVar,
  type IAppProject,
} from "../database/workspace-schema";
import { decryptString, encryptString } from "../services/crypto.service";

/** Invalid input, told apart from infrastructure failure for a clean 400. */
export class AppEnvValidationError extends Error {}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 8192;
const MAX_VARS_PER_APP = 64;

/**
 * Names the sandbox contract owns. Letting an app var shadow these would not
 * leak anything, but it would break the box in ways that look like anything
 * except an env var (PATH → nothing runs; HOME → npm writes caches into the
 * tree and the next commit ships them).
 */
const RESERVED_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "CI",
  "NO_UPDATE_NOTIFIER",
  "GIT_TERMINAL_PROMPT",
  "npm_config_yes",
]);

/** `MAKO_*` is the box↔API contract (box.ts) — never user-assignable. */
const RESERVED_PREFIX = "MAKO_";

/** Vite inlines `VITE_*` into the served client bundle. */
const CLIENT_EXPOSED_PREFIX = "VITE_";

export interface AppEnvVarInput {
  key: string;
  value: string;
  secret: boolean;
}

/** A var as the API returns it: secrets never echo their value back. */
export interface AppEnvVarView {
  key: string;
  secret: boolean;
  /** Decrypted value for non-secret vars; absent for secrets. */
  value?: string;
}

/** Where a resolved env is about to be injected. */
export type AppEnvTarget = "dev" | "build";

export function validateAppEnvInput(input: AppEnvVarInput): void {
  const { key, value, secret } = input;
  if (!KEY_PATTERN.test(key)) {
    throw new AppEnvValidationError(
      "Keys must look like environment variable names: letters, digits and underscores, not starting with a digit.",
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new AppEnvValidationError(
      `Keys are limited to ${MAX_KEY_LENGTH} characters.`,
    );
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new AppEnvValidationError(
      `Values are limited to ${MAX_VALUE_LENGTH} characters.`,
    );
  }
  if (RESERVED_KEYS.has(key) || key.toUpperCase().startsWith(RESERVED_PREFIX)) {
    throw new AppEnvValidationError(
      `"${key}" is reserved by the sandbox and cannot be set per app.`,
    );
  }
  if (secret && key.toUpperCase().startsWith(CLIENT_EXPOSED_PREFIX)) {
    throw new AppEnvValidationError(
      `Vite inlines ${CLIENT_EXPOSED_PREFIX}* variables into the public client bundle, so a secret cannot use that prefix. Mark it non-secret if the value is publishable (Maps keys, anon keys), or rename it if it is truly secret.`,
    );
  }
}

/**
 * The app's CURRENT vars, from Mongo — not from whatever copy of the project
 * the caller happens to hold. Handles are long-lived and projects can be
 * synthesized from repo folders (no row at all), so the doc on a handle can
 * predate any number of env edits; env must reflect the vault, not the cache.
 */
async function freshEnv(project: IAppProject): Promise<IAppEnvVar[]> {
  const row =
    (await AppProject.findById(project._id).select("env")) ??
    (project.slug
      ? await AppProject.findOne({
          workspaceId: new Types.ObjectId(project.workspaceId.toString()),
          slug: project.slug,
        }).select("env")
      : null);
  return row?.env ?? [];
}

export async function listAppEnvVars(
  project: IAppProject,
): Promise<AppEnvVarView[]> {
  const vars = await freshEnv(project);
  return vars.map(v => ({
    key: v.key,
    secret: v.secret,
    ...(v.secret ? {} : { value: decryptString(v.valueEncrypted) }),
  }));
}

/**
 * Upsert one var on a REAL project row (callers materialize synthesized
 * projects with ensureProjectRow first — a vault needs somewhere to live).
 */
export async function setAppEnvVar(
  project: IAppProject,
  input: AppEnvVarInput,
): Promise<AppEnvVarView[]> {
  validateAppEnvInput(input);
  const row = await AppProject.findById(project._id);
  if (!row) throw new Error("App project row not found");
  const vars = row.env ?? [];
  const next: IAppEnvVar = {
    key: input.key,
    valueEncrypted: encryptString(input.value),
    secret: input.secret,
  };
  const at = vars.findIndex(v => v.key === input.key);
  if (at >= 0) {
    vars[at] = next;
  } else {
    if (vars.length >= MAX_VARS_PER_APP) {
      throw new AppEnvValidationError(
        `An app can hold at most ${MAX_VARS_PER_APP} environment variables.`,
      );
    }
    vars.push(next);
  }
  row.env = vars;
  await row.save();
  return listAppEnvVars(row);
}

/** Remove one var. False when it was not there — idempotent for the caller. */
export async function deleteAppEnvVar(
  project: IAppProject,
  key: string,
): Promise<boolean> {
  const row = await AppProject.findById(project._id);
  if (!row?.env?.some(v => v.key === key)) return false;
  row.env = row.env.filter(v => v.key !== key);
  await row.save();
  return true;
}

/**
 * The env record to inject for a target, decrypted.
 *
 * `dev` gets everything — the sandbox dev server is the one place a secret
 * may exist as a process env var. `build` gets only non-secret vars, so
 * nothing secret can influence a published artifact, ever: the publish build
 * IS the public bundle, and the clean invariant beats a plausible exception.
 */
export async function resolveAppEnv(
  project: IAppProject,
  target: AppEnvTarget,
): Promise<Record<string, string>> {
  const vars = await freshEnv(project);
  const included = vars.filter(v => (target === "build" ? !v.secret : true));
  // Sorted so the launch command's env is deterministic run to run.
  included.sort((a, b) => a.key.localeCompare(b.key));
  return Object.fromEntries(
    included.map(v => [v.key, decryptString(v.valueEncrypted)]),
  );
}
