/**
 * dbt environment helpers.
 *
 * Three related concerns live here:
 *
 *  1. **Prod-like environment resolution** — the environment whose successful
 *     runs update `lastProdManifestKey` (used for `--defer` and Slim CI), and
 *     the environment app data bindings resolve `{{ dbt_schema }}` against by
 *     default. Convention: an environment literally named "prod" wins,
 *     otherwise the project default.
 *
 *  2. **Personal (per-developer) environments** — dbt Cloud-style development
 *     credentials. Each user can own one auto-provisioned environment per
 *     project (`ownerUserId`), building into their own schema
 *     (`dbt_<user-slug>`), so iterating never touches shared dev/prod schemas.
 *
 *  3. **dbt-schema resolution for app bindings** — maps a
 *     (project, environment) pair to the warehouse schema apps substitute for
 *     the `{{ dbt_schema }}` token in dbt-linked binding queries.
 */

import { Types } from "mongoose";
import { containsDbtSchemaToken, resolveDbtSchemaToken } from "@mako/schemas";
import {
  DbtEnvPreference,
  DbtProject,
  type IDbtEnvironment,
  type IDbtProject,
} from "../database/workspace-schema";
import { getUserDisplayName } from "../services/entity-version.service";
import { isWarehouseWriteCommand, type ParsedDbtCommand } from "./commands";

type ProjectEnvFields = Pick<
  IDbtProject,
  "environments" | "defaultEnvironment"
> & { prodEnvironment?: string };

/**
 * The environment treated as "production": the defer-state source
 * (`lastProdManifestKey` promotion), the `{{ dbt_schema }}` target for
 * app bindings, and the environment protected from ad-hoc warehouse writes.
 *
 * An explicit `project.prodEnvironment` wins (set in project settings, shown
 * in the UI); a stale value pointing at a removed environment is ignored.
 * Convention fallback: the environment literally named "prod" when one
 * exists, else the project default.
 */
export function resolveProdLikeEnvironmentName(
  project: ProjectEnvFields,
): string {
  if (
    project.prodEnvironment &&
    project.environments.some(env => env.name === project.prodEnvironment)
  ) {
    return project.prodEnvironment;
  }
  return project.environments.some(env => env.name === "prod")
    ? "prod"
    : project.defaultEnvironment;
}

/**
 * Thrown when an ad-hoc run would write into the protected (prod-like)
 * environment. Mapped to HTTP 400 by the dbt routes.
 */
export class DbtProtectedEnvironmentError extends Error {
  constructor(environmentName: string, trackedBranch?: string) {
    super(
      `Ad-hoc dbt runs build your working tree (checkout branch + ` +
        `uncommitted drafts) and are not allowed to write to the protected ` +
        `"${environmentName}" environment. Deploys to "${environmentName}" ` +
        `must go through a saved job or CI, which build the committed` +
        `${trackedBranch ? ` "${trackedBranch}"` : ""} branch — merge your ` +
        `changes first, then trigger the job.`,
    );
    this.name = "DbtProtectedEnvironmentError";
  }
}

/**
 * Guard for ad-hoc (working-tree) runs on repo-connected projects: they build
 * the CALLER's checkout + uncommitted drafts, so letting one write into the
 * prod-like environment would deploy unreviewed code and bypass the
 * protected-branch → PR → job pipeline. Jobs and CI are the only paths that
 * build the prod-like environment (they always build a committed tree).
 *
 * Read-only commands (parse / compile / show / test without
 * --store-failures) stay allowed against any environment, and projects
 * without a repo binding are exempt (jobs and ad-hoc runs there build the
 * same shared tree, so there is nothing to bypass).
 */
export function assertAdhocDbtRunAllowed(
  project: ProjectEnvFields & { repo?: { branch?: string } | null },
  environmentName: string,
  commands: ParsedDbtCommand[],
): void {
  if (!project.repo) return;
  if (!commands.some(isWarehouseWriteCommand)) return;
  const prodLike = resolveProdLikeEnvironmentName(project);
  if (environmentName !== prodLike) return;
  throw new DbtProtectedEnvironmentError(prodLike, project.repo.branch);
}

/** The acting user's personal environment on this project, if provisioned. */
export function findPersonalEnvironment(
  project: ProjectEnvFields,
  userId: string | undefined,
): IDbtEnvironment | undefined {
  if (!userId) return undefined;
  return project.environments.find(env => env.ownerUserId === userId);
}

/**
 * Environment an agent/user action targets when none is given explicitly:
 * the caller's personal environment when provisioned, else the project
 * default. Explicit names always win (validated downstream).
 *
 * Pure fallback used when the per-user preference is unavailable — most
 * callers should use {@link resolveDevEnvironmentForUser}, which also
 * consults the persisted per-user choice.
 */
export function resolveEnvironmentNameForUser(
  project: ProjectEnvFields,
  userId: string | undefined,
  requested?: string,
): string {
  if (requested) return requested;
  return (
    findPersonalEnvironment(project, userId)?.name ?? project.defaultEnvironment
  );
}

type ProjectIdEnvFields = ProjectEnvFields & Pick<IDbtProject, "_id">;

/**
 * The user's saved DEVELOPMENT environment for a project, or undefined when
 * unset / stale (env no longer exists).
 */
export async function getUserDevEnvPreference(
  project: ProjectIdEnvFields,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const pref = await DbtEnvPreference.findOne({
    projectId: project._id,
    userId,
  })
    .select("environment")
    .lean();
  if (!pref) return undefined;
  return project.environments.some(env => env.name === pref.environment)
    ? pref.environment
    : undefined;
}

/** Persist (or clear, with null) the user's dev environment for a project. */
export async function setUserDevEnvPreference(params: {
  workspaceId: Types.ObjectId | string;
  projectId: Types.ObjectId | string;
  userId: string;
  environment: string | null;
}): Promise<void> {
  const projectId = new Types.ObjectId(params.projectId.toString());
  if (params.environment === null) {
    await DbtEnvPreference.deleteOne({ projectId, userId: params.userId });
    return;
  }
  await DbtEnvPreference.updateOne(
    { projectId, userId: params.userId },
    {
      $set: {
        workspaceId: new Types.ObjectId(params.workspaceId.toString()),
        environment: params.environment,
      },
    },
    { upsert: true },
  );
}

/**
 * THE per-user development-environment resolution — the environment a user's
 * ad-hoc work (editor runs, agent builds, previews) targets when none is
 * requested explicitly:
 *
 *   explicit request > the user's saved per-user choice > their personal
 *   environment (when provisioned) > the project default.
 *
 * Single player: no choice + no personal env → the shared dev default (dev IS
 * their personal target). Multiple players: each user's choice / personal
 * env keeps their work out of teammates' schemas.
 */
export async function resolveDevEnvironmentForUser(
  project: ProjectIdEnvFields,
  userId: string | undefined,
  requested?: string,
): Promise<string> {
  if (requested) return requested;
  const preferred = await getUserDevEnvPreference(project, userId);
  if (preferred) return preferred;
  return resolveEnvironmentNameForUser(project, userId);
}

/**
 * Slug for personal schema/environment names: local-part of an email (or any
 * display string) lowercased and reduced to [a-z0-9_], bounded so the
 * resulting identifier stays valid across warehouses.
 */
export function sanitizePersonalSlug(input: string): string {
  const local = input.split("@")[0] ?? input;
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "user";
}

export interface EnsurePersonalEnvironmentResult {
  environment: IDbtEnvironment;
  created: boolean;
}

/**
 * Idempotently provision the acting user's personal environment on a project.
 * The environment clones the prod-like environment's connection (same
 * warehouse, different schema) and builds into `dbt_<slug>`. Name/schema
 * collisions with existing non-personal environments get a numeric suffix.
 */
export async function ensurePersonalDbtEnvironment(params: {
  workspaceId: string;
  projectId: string;
  userId: string;
}): Promise<EnsurePersonalEnvironmentResult> {
  const project = await DbtProject.findOne({
    _id: new Types.ObjectId(params.projectId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!project) throw new Error("dbt project not found");

  const existing = findPersonalEnvironment(project, params.userId);
  if (existing) return { environment: existing, created: false };

  const slug = sanitizePersonalSlug(await getUserDisplayName(params.userId));

  const taken = new Set(project.environments.map(env => env.name));
  let name = slug;
  let suffix = 2;
  while (taken.has(name)) name = `${slug}_${suffix++}`;

  const takenSchemas = new Set(
    project.environments.map(env => env.targetSchema),
  );
  let targetSchema = `dbt_${slug}`;
  suffix = 2;
  while (takenSchemas.has(targetSchema)) {
    targetSchema = `dbt_${slug}_${suffix++}`;
  }

  const baseEnvName = resolveProdLikeEnvironmentName(project);
  const baseEnv =
    project.environments.find(env => env.name === baseEnvName) ??
    project.environments[0];
  if (!baseEnv) {
    throw new Error("Project has no environments to clone a connection from");
  }

  const environment: IDbtEnvironment = {
    name,
    connectionId: baseEnv.connectionId,
    targetSchema,
    threads: baseEnv.threads ?? 4,
    vars: baseEnv.vars,
    ownerUserId: params.userId,
  };
  project.environments.push(environment);
  project.markModified("environments");
  await project.save();

  return { environment, created: true };
}

/**
 * Resolve the warehouse schema for a dbt project environment — used to
 * substitute the `{{ dbt_schema }}` token in dbt-linked app data bindings.
 * Defaults to the prod-like environment so published apps and materialized
 * artifacts always read production data. Returns null when the project or
 * environment cannot be resolved (callers fall back to the raw query, which
 * then fails loudly in the warehouse instead of silently querying the wrong
 * schema).
 */
export async function resolveDbtSchemaForBinding(params: {
  workspaceId: string | Types.ObjectId;
  dbtProjectId: string;
  environmentName?: string;
}): Promise<{ schema: string; environmentName: string } | null> {
  if (!Types.ObjectId.isValid(params.dbtProjectId)) return null;
  const project = await DbtProject.findOne({
    _id: new Types.ObjectId(params.dbtProjectId),
    workspaceId: new Types.ObjectId(params.workspaceId.toString()),
  })
    .select("environments defaultEnvironment prodEnvironment")
    .lean();
  if (!project) return null;

  const envName =
    params.environmentName ?? resolveProdLikeEnvironmentName(project);
  const environment = project.environments.find(env => env.name === envName);
  if (!environment) return null;
  return { schema: environment.targetSchema, environmentName: envName };
}

/**
 * Server-side resolution of a dbt-linked binding's query: substitutes
 * `{{ dbt_schema }}` with the prod-like environment's schema (the only
 * environment server paths — parquet materialization, public shares — ever
 * read from; preview overrides are a client/editor concern). Returns the code
 * unchanged when the binding has no dbt link or no token. Throws when the
 * link is set + the token is used but the project/environment cannot be
 * resolved, so a broken link fails loudly instead of querying a literal
 * `{{ dbt_schema }}` schema.
 */
export async function resolveDbtBoundCode(params: {
  workspaceId: string | Types.ObjectId;
  dbtProjectId?: string;
  code: string;
}): Promise<string> {
  if (!params.dbtProjectId || !containsDbtSchemaToken(params.code)) {
    return params.code;
  }
  const resolved = await resolveDbtSchemaForBinding({
    workspaceId: params.workspaceId,
    dbtProjectId: params.dbtProjectId,
  });
  if (!resolved) {
    throw new Error(
      "The dbt project linked to this data source is unavailable — cannot resolve {{ dbt_schema }}",
    );
  }
  return resolveDbtSchemaToken(params.code, resolved.schema);
}
