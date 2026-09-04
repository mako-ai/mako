/**
 * dbt routes — projects, files, jobs, runs, ad-hoc compile/run, lineage.
 *
 * Mounted at `/api/workspaces/:workspaceId/dbt`. Authenticated +
 * workspace-scoped (unifiedAuthMiddleware then the same workspace access
 * check as skills.ts). Business logic lives in api/src/dbt/**.
 */

import { Hono } from "hono";
import { workspaceResourceLoader } from "./lib/load-resource";
import { Readable } from "stream";
import { Types } from "mongoose";
import { z } from "zod";
import { RepoRequiredError } from "../apps/config";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  DbtEnvPreference,
  DbtJob,
  DbtProject,
  DbtRun,
  DatabaseConnection,
} from "../database/workspace-schema";
import {
  commitDbtFiles,
  deleteWorkingFile,
  getCheckoutBranch,
  listWorkingFiles,
  readWorkingFile,
  renameWorkingFile,
  writeWorkingFile,
} from "../dbt/dbt-working-tree.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import {
  DBT_COMPATIBLE_CONNECTION_TYPES,
  isDbtCompatibleConnectionType,
} from "../dbt/adapter-map";
import { resolveDbtAccess } from "../dbt/rbac";
import {
  DbtCommandValidationError,
  isWarehouseWriteCommand,
  parseDbtCommand,
  parseDbtCommands,
} from "../dbt/commands";
import { buildStarterScaffold } from "../dbt/scaffold";
import {
  commitDbtEnvironmentsFile,
  commitDbtJobFile,
  deleteDbtJobFile,
  ensureEnvironmentsDerivedCache,
  jobScheduleFailure,
  loadLiveJobById,
  loadLiveJobs,
  liveJobToPlain,
  reserveJobSlug,
  resolveLiveJobRow,
} from "../dbt/dbt-config.service";
import {
  DBT_PREVIEW_DEFAULT_LIMIT,
  DBT_PREVIEW_MAX_LIMIT,
  parseDbtShowPreview,
} from "../dbt/dbt-show";
import {
  loadDbtDeferState,
  runAdhocDbtCommand,
} from "../dbt/dbt-project.service";
import {
  DbtProtectedEnvironmentError,
  ensurePersonalDbtEnvironment,
  setUserDevEnvPreference,
} from "../dbt/dbt-environments.service";
import {
  applyJobScheduleChange,
  recordCompletedAdhocDbtRun,
  reconcileStaleQueuedRun,
  reconcileStaleQueuedRuns,
  requestDbtRunCancel,
  triggerDbtJobRun,
  triggerDbtRunRetry,
} from "../dbt/dbt-run.service";
import { validateScheduledConsoleSchedule } from "../services/scheduled-query-schedule.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const logger = loggers.api("dbt");

export const dbtRoutes = new Hono();

dbtRoutes.use("*", unifiedAuthMiddleware);

// Workspace access check — mirrors skills.ts, and resolves the caller's
// workspace role (memberRole) so the RBAC policy below can gate mutations.
dbtRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    await next();
    return;
  }
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { success: false, error: "API key not authorized for this workspace" },
        403,
      );
    }
    // Workspace-scoped API keys are service credentials with full access.
    c.set("memberRole", "owner");
  } else if (user) {
    const member = await workspaceService.getMember(workspaceId, user.id);
    if (!member) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
    c.set("memberRole", member.role);
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

// RBAC policy lives in ../dbt/rbac.ts (pure + unit-tested). Reads (GET) are
// open to any member incl. viewer; viewers are otherwise read-only;
// deployment-config mutations require admin+; other writes are member+.
dbtRoutes.use("*", async (c: AuthenticatedContext, next) => {
  if (!c.req.param("workspaceId")) {
    await next();
    return;
  }
  const decision = resolveDbtAccess({
    method: c.req.method,
    path: c.req.path,
    role: c.get("memberRole"),
  });
  if (!decision.ok) {
    return c.json(
      { success: false, error: decision.error },
      decision.status ?? 403,
    );
  }
  await next();
});

function getUserId(c: AuthenticatedContext): string {
  return c.get("user")?.id ?? "api-key";
}

function badRequest(c: AuthenticatedContext, message: string) {
  return c.json({ success: false, error: message }, 400);
}

function serverError(
  c: AuthenticatedContext,
  error: unknown,
  fallback: string,
) {
  if (error instanceof RepoRequiredError) {
    return c.json(
      { success: false, code: error.code, error: error.message },
      error.status as 412,
    );
  }
  if (error instanceof DbtProtectedEnvironmentError) {
    return c.json({ success: false, error: error.message }, 400);
  }
  logger.error(fallback, { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : fallback,
    },
    500,
  );
}

/**
 * Realtime pokes so every open window (this user's and, for committed/base
 * changes, other users') refreshes without a manual reload — the same
 * poke-then-pull channel the agent's server tools use.
 */
function publishDbtEvent(
  c: AuthenticatedContext,
  event: Parameters<typeof publishRealtimeEvent>[1],
): void {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) publishRealtimeEvent(workspaceId, event);
}

const environmentSchema = z.object({
  name: z.string().min(1).max(64),
  connectionId: z
    .string()
    .refine(Types.ObjectId.isValid, "Invalid connection id"),
  targetSchema: z.string().min(1).max(128),
  threads: z.number().int().min(1).max(16).default(4),
  vars: z.record(z.string(), z.unknown()).optional(),
  /**
   * Personal environment owner (per-developer target). Auto-provisioned via
   * POST .../environments/personal, and editable from environment settings
   * (claim/release). Round-tripped by settings saves so admin edits never
   * strip ownership.
   */
  ownerUserId: z.string().optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(128),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1),
  defaultEnvironment: z.string().min(1),
});

// GitHub owner/repo names are alphanumeric plus '.', '_', '-'. Validating the
// charset (and rejecting '..') before these values are interpolated into
// api.github.com paths prevents API-path injection / traversal.
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isValidRepoSegment(value: string): boolean {
  return (
    REPO_SEGMENT_RE.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..")
  );
}

const patchProjectSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1).optional(),
  defaultEnvironment: z.string().min(1).optional(),
  /**
   * Explicit production (defer target) environment; empty string clears the
   * override back to the convention (env named "prod", else the default).
   */
  prodEnvironment: z.string().max(64).optional(),
});

/**
 * Personal environments are per-user build targets: at most one per user, and
 * never the shared default or the production (defer target) environment —
 * both are resolved for OTHER users too, so pointing them at a private
 * schema would leak one developer's scratch data into everyone's builds.
 */
function validatePersonalEnvironments(
  environments: Array<{ name: string; ownerUserId?: string }>,
  defaultEnvironment: string | undefined,
  prodEnvironment: string | undefined,
): string | null {
  const ownedNames = new Map<string, string>();
  for (const env of environments) {
    if (!env.ownerUserId) continue;
    const prior = ownedNames.get(env.ownerUserId);
    if (prior) {
      return (
        `"${prior}" and "${env.name}" are personal environments of the ` +
        `same user — each user can own only one per project`
      );
    }
    ownedNames.set(env.ownerUserId, env.name);
  }
  const isPersonal = (name: string | undefined) =>
    Boolean(name) && environments.some(e => e.name === name && e.ownerUserId);
  if (isPersonal(defaultEnvironment)) {
    return `Default environment "${defaultEnvironment}" cannot be a personal environment`;
  }
  if (isPersonal(prodEnvironment)) {
    return `Production environment "${prodEnvironment}" cannot be a personal environment`;
  }
  return null;
}

async function validateEnvironments(
  workspaceId: string,
  environments: z.infer<typeof environmentSchema>[],
): Promise<string | null> {
  const names = new Set<string>();
  for (const env of environments) {
    if (names.has(env.name)) return `Duplicate environment name "${env.name}"`;
    names.add(env.name);
    const connection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(env.connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    }).select("type");
    if (!connection) {
      return `Connection not found for environment "${env.name}"`;
    }
    if (!isDbtCompatibleConnectionType(connection.type)) {
      return (
        `Connection type "${connection.type}" is not dbt-compatible. ` +
        `Supported: ${DBT_COMPATIBLE_CONNECTION_TYPES.join(", ")}`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// GET / — list projects with job/run rollups for the explorer. Each project
// carries `myDevEnvironment`: the CALLER's saved per-user dev environment
// (single player: unset → the shared default; teams: each user's own).
dbtRoutes.get("/projects", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const docs = await DbtProject.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ updatedAt: -1 });
    // Environments follow dbt/environments.yml at main (apps.md §23).
    for (const doc of docs) {
      try {
        await ensureEnvironmentsDerivedCache(doc);
      } catch (error) {
        logger.warn("ensureEnvironmentsDerivedCache failed", {
          projectId: doc._id.toString(),
          error,
        });
      }
    }
    const projects = docs.map(doc => doc.toObject());
    const userId = getUserId(c);
    const prefs = await DbtEnvPreference.find({
      projectId: { $in: projects.map(p => p._id) },
      userId,
    })
      .select("projectId environment")
      .lean();
    const prefByProject = new Map(
      prefs.map(pref => [pref.projectId.toString(), pref.environment]),
    );
    const enriched = projects.map(project => {
      const preferred = prefByProject.get(project._id.toString());
      // Stale choices (env renamed/removed) are dropped, not surfaced.
      const valid =
        preferred && project.environments.some(env => env.name === preferred)
          ? preferred
          : undefined;
      return { ...project, myDevEnvironment: valid };
    });
    return c.json({ success: true, projects: enriched });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt projects");
  }
});

dbtRoutes.post("/projects", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const parsed = createProjectSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(
        c,
        parsed.error.issues[0]?.message ?? "Invalid project",
      );
    }
    const body = parsed.data;
    if (!body.environments.some(env => env.name === body.defaultEnvironment)) {
      return badRequest(
        c,
        `Default environment "${body.defaultEnvironment}" is not in environments`,
      );
    }
    const envError = await validateEnvironments(workspaceId, body.environments);
    if (envError) return badRequest(c, envError);
    const personalError = validatePersonalEnvironments(
      body.environments,
      body.defaultEnvironment,
      undefined,
    );
    if (personalError) return badRequest(c, personalError);

    const userId = getUserId(c);
    // ONE dbt project per workspace: the project is the `dbt/` folder of the
    // workspace repo (apps.md §20), and two projects cannot share it.
    const existing = await DbtProject.exists({
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (existing) {
      return badRequest(
        c,
        "This workspace already has a dbt project (dbt/ in the workspace repo)",
      );
    }
    const project = new DbtProject({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name,
      dbtVersion: body.dbtVersion ?? "1.9",
      environments: body.environments.map(env => ({
        ...env,
        connectionId: new Types.ObjectId(env.connectionId),
      })),
      defaultEnvironment: body.defaultEnvironment,
      createdBy: userId,
    });
    // Git first (issue #956): the file is the record, the row follows.
    await commitDbtEnvironmentsFile(project, userId);
    await project.save();

    // Scaffold straight into the workspace repo: dbt/ appears as one commit
    // on the creator's session branch. A pre-existing dbt/dbt_project.yml
    // (external import) is left untouched.
    const alreadyInRepo = await readWorkingFile(
      project,
      userId,
      "dbt_project.yml",
    );
    if (!alreadyInRepo) {
      const scaffold = buildStarterScaffold(body.name);
      await commitDbtFiles(
        project,
        userId,
        Object.fromEntries(scaffold.map(f => [f.path, f.content])),
        `dbt: scaffold project "${body.name}"`,
      );
    }

    publishDbtEvent(c, {
      type: "dbt.project.updated",
      projectId: project._id.toString(),
    });
    return c.json({ success: true, project });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return badRequest(c, "A dbt project with this name already exists");
    }
    return serverError(c, error, "Failed to create dbt project");
  }
});

const findProject = workspaceResourceLoader(DbtProject, "projectId");

dbtRoutes.get("/projects/:projectId", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    // Environments follow dbt/environments.yml at main (apps.md §23).
    await ensureEnvironmentsDerivedCache(project);
    return c.json({ success: true, project });
  } catch (error) {
    return serverError(c, error, "Failed to fetch dbt project");
  }
});

dbtRoutes.patch("/projects/:projectId", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const parsed = patchProjectSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid patch");
    }
    const body = parsed.data;

    if (body.environments) {
      const envError = await validateEnvironments(
        project.workspaceId.toString(),
        body.environments,
      );
      if (envError) return badRequest(c, envError);
      project.environments = body.environments.map(env => ({
        ...env,
        connectionId: new Types.ObjectId(env.connectionId),
      }));
    }
    if (body.name) project.name = body.name;
    if (body.dbtVersion) project.dbtVersion = body.dbtVersion;
    if (body.defaultEnvironment) {
      project.defaultEnvironment = body.defaultEnvironment;
    }
    if (
      !project.environments.some(env => env.name === project.defaultEnvironment)
    ) {
      return badRequest(
        c,
        `Default environment "${project.defaultEnvironment}" is not in environments`,
      );
    }
    if (body.prodEnvironment !== undefined) {
      if (body.prodEnvironment === "") {
        project.prodEnvironment = undefined;
      } else {
        if (
          !project.environments.some(env => env.name === body.prodEnvironment)
        ) {
          return badRequest(
            c,
            `Production environment "${body.prodEnvironment}" is not in environments`,
          );
        }
        project.prodEnvironment = body.prodEnvironment;
      }
    }
    {
      const personalError = validatePersonalEnvironments(
        project.environments,
        project.defaultEnvironment,
        project.prodEnvironment,
      );
      if (personalError) return badRequest(c, personalError);
    }
    await commitDbtEnvironmentsFile(project, getUserId(c));
    await project.save();
    publishDbtEvent(c, {
      type: "dbt.project.updated",
      projectId: project._id.toString(),
    });
    return c.json({ success: true, project });
  } catch (error) {
    return serverError(c, error, "Failed to update dbt project");
  }
});

// POST /projects/:projectId/environments/personal — idempotently provision
// the caller's personal (per-developer) environment: same connection as the
// prod-like environment, private schema `dbt_<user>`. Member+ (not admin-only:
// unlike shared environment config, this only affects the caller's own
// iteration target).
dbtRoutes.post(
  "/projects/:projectId/environments/personal",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const userId = c.get("user")?.id;
      if (!userId) {
        return badRequest(
          c,
          "Personal environments require a user session (not an API key)",
        );
      }
      const result = await ensurePersonalDbtEnvironment({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        userId,
      });
      if (result.created) {
        publishDbtEvent(c, {
          type: "dbt.project.updated",
          projectId: project._id.toString(),
        });
      }
      return c.json({
        success: true,
        created: result.created,
        environment: {
          name: result.environment.name,
          targetSchema: result.environment.targetSchema,
          connectionId: result.environment.connectionId?.toString(),
          threads: result.environment.threads,
          ownerUserId: result.environment.ownerUserId,
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to create personal environment");
    }
  },
);

// PUT /projects/:projectId/my-environment — the CALLER's default DEVELOPMENT
// environment for this project (a per-user setting: the editor/console env
// pickers persist here, and agent builds default to it). Body:
// { environment } — "" clears back to Auto (personal env when provisioned,
// else the project default). Member+ (only affects the caller's own target).
dbtRoutes.put(
  "/projects/:projectId/my-environment",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const parsed = z
        .object({ environment: z.string().max(64) })
        .safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return badRequest(c, "environment (string) is required");
      }
      const environment = parsed.data.environment;
      if (
        environment !== "" &&
        !project.environments.some(env => env.name === environment)
      ) {
        return badRequest(
          c,
          `Environment "${environment}" is not in the project`,
        );
      }
      const userId = getUserId(c);
      await setUserDevEnvPreference({
        workspaceId: project.workspaceId,
        projectId: project._id,
        userId,
        environment: environment === "" ? null : environment,
      });
      return c.json({
        success: true,
        myDevEnvironment: environment === "" ? undefined : environment,
      });
    } catch (error) {
      return serverError(c, error, "Failed to save your dev environment");
    }
  },
);

dbtRoutes.delete("/projects/:projectId", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    // The dbt/ folder in the repo is deliberately left alone: deleting the
    // project row removes the runner surface, not the files (git history is
    // the recovery path either way).
    await Promise.all([
      DbtEnvPreference.deleteMany({ projectId: project._id }),
      DbtJob.deleteMany({ projectId: project._id }),
      DbtRun.deleteMany({ projectId: project._id }),
    ]);
    await project.deleteOne();
    publishDbtEvent(c, {
      type: "dbt.project.updated",
      projectId: project._id.toString(),
    });
    return c.json({ success: true });
  } catch (error) {
    return serverError(c, error, "Failed to delete dbt project");
  }
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function isSafeDbtPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\")
  );
}

// File reads/writes address the dbt/ folder of the workspace repo at the
// caller's SESSION branch (apps.md §20): a save is a commit, visible to
// whoever is on that branch — separate branches, separate views, like clones.

dbtRoutes.get("/projects/:projectId/files", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const files = await listWorkingFiles(project, getUserId(c));
    return c.json({ success: true, files });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt files");
  }
});

dbtRoutes.get(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const path = c.req.param("path");
      const file = await readWorkingFile(project, getUserId(c), path);
      if (!file) {
        return c.json({ success: false, error: "File not found" }, 404);
      }
      return c.json({ success: true, file });
    } catch (error) {
      return serverError(c, error, "Failed to read dbt file");
    }
  },
);

dbtRoutes.put(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const path = c.req.param("path");
      if (!isSafeDbtPath(path)) return badRequest(c, "Invalid file path");

      const body = (await c.req.json()) as {
        content?: unknown;
        clientId?: unknown;
      };
      if (typeof body.content !== "string") {
        return badRequest(c, "content (string) is required");
      }
      if (body.content.length > 1_000_000) {
        return badRequest(c, "File too large (max 1MB)");
      }

      const userId = getUserId(c);
      // A save is a commit on the caller's session branch; git history
      // replaces the retired dbt-file entity-version snapshots.
      await writeWorkingFile(project, userId, path, body.content);

      await DbtProject.updateOne(
        { _id: project._id },
        { $currentDate: { updatedAt: true } },
      );
      // A save is a commit: poke the workspace so every open window on the
      // branch refreshes (branch scoping happens at read time).
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path,
        updatedBy: userId,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        origin: "save",
      });
      return c.json({
        success: true,
        file: { path, content: body.content, updatedBy: userId },
      });
    } catch (error) {
      return serverError(c, error, "Failed to save dbt file");
    }
  },
);

dbtRoutes.delete(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const path = c.req.param("path");
      const userId = getUserId(c);
      const deleted = await deleteWorkingFile(project, userId, path);
      if (!deleted) {
        return c.json({ success: false, error: "File not found" }, 404);
      }
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path,
        deleted: true,
        updatedBy: userId,
        origin: "save",
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to delete dbt file");
    }
  },
);

dbtRoutes.post(
  "/projects/:projectId/files/rename",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const body = (await c.req.json()) as {
        from?: unknown;
        to?: unknown;
        clientId?: unknown;
      };
      const from = typeof body.from === "string" ? body.from : "";
      const to = typeof body.to === "string" ? body.to : "";
      if (!isSafeDbtPath(from) || !isSafeDbtPath(to)) {
        return badRequest(c, "Invalid from/to path");
      }
      const userId = getUserId(c);
      const renameError = await renameWorkingFile(project, userId, from, to);
      if (renameError === "File not found") {
        return c.json({ success: false, error: renameError }, 404);
      }
      if (renameError) return badRequest(c, renameError);
      // The rename is one commit (delete + add) — poke both paths so open
      // windows move the file.
      const clientId =
        typeof body.clientId === "string" ? body.clientId : undefined;
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path: from,
        deleted: true,
        updatedBy: userId,
        clientId,
        origin: "save",
      });
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path: to,
        updatedBy: userId,
        clientId,
        origin: "save",
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to rename dbt file");
    }
  },
);

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobSchema = z.object({
  name: z.string().min(1).max(128),
  environment: z.string().min(1),
  commands: z.array(z.string().min(1)).min(1).max(10),
  schedule: z
    .object({
      cron: z.string().min(1),
      timezone: z.string().min(1),
    })
    .nullable()
    .optional(),
  enabled: z.boolean().default(true),
  deferToProduction: z.boolean().default(false),
});

function validateJobBody(
  project: { environments: Array<{ name: string }> },
  body: z.infer<typeof jobSchema>,
): string | null {
  if (!project.environments.some(env => env.name === body.environment)) {
    return `Environment "${body.environment}" not found on project`;
  }
  try {
    parseDbtCommands(body.commands);
  } catch (error) {
    if (error instanceof DbtCommandValidationError) return error.message;
    throw error;
  }
  if (body.schedule) {
    try {
      validateScheduledConsoleSchedule(body.schedule);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid schedule";
    }
    // Same check the git overlay and push-sync apply (catches a timezone
    // cron-parser only rejects when computing the next run).
    const scheduleFailure = jobScheduleFailure(body.schedule);
    if (scheduleFailure) return scheduleFailure;
  }
  return null;
}

dbtRoutes.get("/projects/:projectId/jobs", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const jobs = (await loadLiveJobs(project)).map(job =>
      liveJobToPlain(job, project),
    );
    return c.json({ success: true, jobs });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt jobs");
  }
});

dbtRoutes.get(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const live = await loadLiveJobById(project, c.req.param("jobId"));
      if (!live) {
        return c.json({ success: false, error: "Job not found" }, 404);
      }
      return c.json({ success: true, job: liveJobToPlain(live, project) });
    } catch (error) {
      return serverError(c, error, "Failed to get dbt job");
    }
  },
);

dbtRoutes.post("/projects/:projectId/jobs", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const parsed = jobSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid job");
    }
    const validationError = validateJobBody(project, parsed.data);
    if (validationError) return badRequest(c, validationError);

    const job = new DbtJob({
      workspaceId: project.workspaceId,
      projectId: project._id,
      slug: await reserveJobSlug(project._id, parsed.data.name),
      name: parsed.data.name,
      environment: parsed.data.environment,
      commands: parsed.data.commands,
      schedule: parsed.data.schedule ?? undefined,
      enabled: parsed.data.enabled,
      deferToProduction: parsed.data.deferToProduction,
      createdBy: getUserId(c),
    });
    // Git first: the file is the record, the derived row follows.
    await commitDbtJobFile(project, job, getUserId(c));
    await job.save();
    await applyJobScheduleChange(job);
    const fresh = await DbtJob.findById(job._id).lean();
    publishDbtEvent(c, {
      type: "dbt.job.updated",
      projectId: project._id.toString(),
    });
    return c.json({ success: true, job: fresh });
  } catch (error) {
    return serverError(c, error, "Failed to create dbt job");
  }
});

dbtRoutes.patch(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const jobId = c.req.param("jobId");
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return c.json(
          { success: false, error: resolved.error },
          resolved.status,
        );
      }
      const job = resolved.row;
      const parsed = jobSchema.partial().safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid job");
      }
      const merged = {
        name: parsed.data.name ?? job.name,
        environment: parsed.data.environment ?? job.environment,
        commands: parsed.data.commands ?? job.commands,
        schedule:
          parsed.data.schedule === undefined
            ? (job.schedule ?? null)
            : parsed.data.schedule,
        enabled: parsed.data.enabled ?? job.enabled,
        deferToProduction:
          parsed.data.deferToProduction ?? job.deferToProduction,
      };
      const validationError = validateJobBody(project, merged);
      if (validationError) return badRequest(c, validationError);

      job.name = merged.name;
      job.environment = merged.environment;
      job.commands = merged.commands;
      job.schedule = merged.schedule ?? undefined;
      job.enabled = merged.enabled;
      job.deferToProduction = merged.deferToProduction;
      await commitDbtJobFile(project, job, getUserId(c));
      await job.save();
      await applyJobScheduleChange(job);
      const fresh = await DbtJob.findById(job._id).lean();
      publishDbtEvent(c, {
        type: "dbt.job.updated",
        projectId: project._id.toString(),
      });
      return c.json({ success: true, job: fresh });
    } catch (error) {
      return serverError(c, error, "Failed to update dbt job");
    }
  },
);

dbtRoutes.delete(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const jobId = c.req.param("jobId");
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return c.json(
          { success: false, error: resolved.error },
          resolved.status,
        );
      }
      const doomed = resolved.row;
      await deleteDbtJobFile(project, doomed.slug, getUserId(c));
      await DbtJob.deleteOne({ _id: doomed._id });
      publishDbtEvent(c, {
        type: "dbt.job.updated",
        projectId: project._id.toString(),
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to delete dbt job");
    }
  },
);

dbtRoutes.post(
  "/projects/:projectId/jobs/:jobId/trigger",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const jobId = c.req.param("jobId");
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return c.json(
          { success: false, error: resolved.error },
          resolved.status,
        );
      }
      const job = resolved.row;
      const run = await triggerDbtJobRun({
        workspaceId: project.workspaceId.toString(),
        job,
        trigger: "manual",
        triggeredBy: getUserId(c),
      });
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: project._id.toString(),
        runId: run._id.toString(),
        jobId: job._id.toString(),
      });
      return c.json({ success: true, runId: run._id.toString() });
    } catch (error) {
      return serverError(c, error, "Failed to trigger dbt job");
    }
  },
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

dbtRoutes.get("/projects/:projectId/runs", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const jobId = c.req.query("jobId");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
    const filter: Record<string, unknown> = { projectId: project._id };
    if (jobId && Types.ObjectId.isValid(jobId)) {
      filter.jobId = new Types.ObjectId(jobId);
    }
    const runs = await DbtRun.find(filter)
      .select("-logs")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    // Present any run stuck in "queued" past the worker-pickup deadline as
    // errored so history never shows a perpetually-queued run. Read-only on
    // this GET path (persist: false) — the cron sweeper is the single writer.
    const reconciled = await reconcileStaleQueuedRuns(runs, { persist: false });
    return c.json({ success: true, runs: reconciled });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt runs");
  }
});

dbtRoutes.get(
  "/projects/:projectId/runs/:runId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const runId = c.req.param("runId");
      if (!Types.ObjectId.isValid(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const found = await DbtRun.findOne({
        _id: new Types.ObjectId(runId),
        projectId: project._id,
      }).lean();
      if (!found) {
        return c.json({ success: false, error: "Run not found" }, 404);
      }
      // Present a stuck-queued run as errored so the poller (DbtRunCard / Runs
      // view) sees a terminal status instead of spinning on "queued". Read-only
      // on this GET path (persist: false) — the cron sweeper is the writer.
      const run = await reconcileStaleQueuedRun(found, { persist: false });
      // logsSince = number of log lines the client already has (cursor).
      const logsSince = Number(c.req.query("logsSince")) || 0;
      const logs = run.logs ?? [];
      return c.json({
        success: true,
        run: {
          ...run,
          logs: logs.slice(logsSince),
          logCursor: logs.length,
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to fetch dbt run");
    }
  },
);

dbtRoutes.post(
  "/projects/:projectId/runs/:runId/cancel",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const runId = c.req.param("runId");
      if (!Types.ObjectId.isValid(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const result = await requestDbtRunCancel({
        workspaceId: project.workspaceId.toString(),
        runId,
        cancelledBy: getUserId(c),
      });
      if (!result) {
        return c.json({ success: false, error: "Run not found" }, 404);
      }
      // Idempotent: an already-terminal run echoes its current status (no
      // error), and the queued→running / finished-during-cancel races return
      // the real status rather than failing.
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: project._id.toString(),
        runId,
      });
      return c.json({
        success: true,
        status: result.status,
        cancelledAt: result.cancelledAt,
        cancelledBy: result.cancelledBy,
      });
    } catch (error) {
      return serverError(c, error, "Failed to cancel dbt run");
    }
  },
);

dbtRoutes.post(
  "/projects/:projectId/runs/:runId/retry",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const runId = c.req.param("runId");
      if (!Types.ObjectId.isValid(runId)) {
        return badRequest(c, "Invalid run id");
      }
      const run = await triggerDbtRunRetry({
        workspaceId: project.workspaceId.toString(),
        runId,
        triggeredBy: getUserId(c),
      });
      if (!run) {
        return badRequest(
          c,
          "Run cannot be retried (must be a failed run with results)",
        );
      }
      publishDbtEvent(c, {
        type: "dbt.run.updated",
        projectId: project._id.toString(),
        runId: run._id.toString(),
        jobId: run.jobId?.toString(),
      });
      return c.json({ success: true, runId: run._id.toString() });
    } catch (error) {
      return serverError(c, error, "Failed to retry dbt run");
    }
  },
);

dbtRoutes.get(
  "/projects/:projectId/runs/:runId/artifacts/:kind",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const runId = c.req.param("runId");
      const kind = c.req.param("kind");
      if (!Types.ObjectId.isValid(runId)) {
        return badRequest(c, "Invalid run id");
      }
      if (!["manifest", "runResults", "catalog", "sources"].includes(kind)) {
        return badRequest(
          c,
          "kind must be manifest | runResults | catalog | sources",
        );
      }
      const run = await DbtRun.findOne({
        _id: new Types.ObjectId(runId),
        projectId: project._id,
      })
        .select("artifactKeys")
        .lean();
      const key =
        run?.artifactKeys?.[
          kind as "manifest" | "runResults" | "catalog" | "sources"
        ];
      if (!key) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }
      const store = getDashboardArtifactStore();
      const stream = await store.openReadStream(key);
      if (!stream) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }
      return new Response(
        Readable.toWeb(stream as Readable) as ReadableStream,
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, max-age=86400, immutable",
          },
        },
      );
    } catch (error) {
      return serverError(c, error, "Failed to stream dbt artifact");
    }
  },
);

// ---------------------------------------------------------------------------
// Ad-hoc compile / command (synchronous runner invocations)
// ---------------------------------------------------------------------------

const adhocSchema = z.object({
  select: z.string().min(1).max(256).optional(),
  environment: z.string().min(1).optional(),
  /** Slim CI: resolve unselected refs against the last prod manifest. */
  defer: z.boolean().optional(),
});

const commandSchema = z.object({
  command: z.string().min(1).max(512),
  environment: z.string().min(1).optional(),
  defer: z.boolean().optional(),
});

const previewSchema = z.object({
  select: z.string().min(1).max(256),
  environment: z.string().min(1).optional(),
  defer: z.boolean().optional(),
  limit: z.number().int().min(1).max(DBT_PREVIEW_MAX_LIMIT).optional(),
});

const SELECT_PATTERN = /^[\w.+@:*\-/]+$/;

// Shared with the agent tools: reads the last prod manifest for
// `--defer --state` (see dbt-project.service.ts).
const loadDeferState = loadDbtDeferState;

/**
 * Prepend a warning when defer was requested but no prod manifest exists, so
 * the UI doesn't silently run without `--defer`. Mutates and returns `logs`.
 */
function noteDeferUnavailable<
  T extends { ts: Date; level: string; line: string },
>(logs: T[], deferRequested: boolean, deferState: Buffer | undefined): T[] {
  if (deferRequested && !deferState) {
    logs.unshift({
      ts: new Date(),
      level: "warn",
      line: "Defer requested but this project has no production manifest yet — ran without --defer. Run the prod environment once to enable defer.",
    } as T);
  }
  return logs;
}

dbtRoutes.post(
  "/projects/:projectId/compile",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const parsed = adhocSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { select, environment, defer } = parsed.data;
      if (select && !SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const command = select ? `compile --select ${select}` : "parse";
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        userId: getUserId(c),
        command,
        select,
        deferState,
        timeoutMs: 3 * 60 * 1000,
      });
      return c.json({
        success: true,
        compile: {
          ok: result.success,
          exitCode: result.exitCode,
          compiledSql: result.compiledSql,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to compile dbt project");
    }
  },
);

// Preview (editor Preview button / ⌘↵). Runs `show --select <node> --limit N
// --output json`: a bounded SELECT over the model's compiled SQL that never
// materializes anything, so it is safe on every environment including prod and
// is deliberately NOT recorded into run history. Returns structured rows for
// the Results grid; `preview: null` means dbt produced no ShowNode payload
// (compile error — read `logs`).
dbtRoutes.post(
  "/projects/:projectId/preview",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const parsed = previewSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { select, environment, defer, limit } = parsed.data;
      if (!SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const rowLimit = limit ?? DBT_PREVIEW_DEFAULT_LIMIT;
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        userId: getUserId(c),
        command: `show --select ${select} --limit ${rowLimit} --output json`,
        deferState,
        timeoutMs: 3 * 60 * 1000,
      });
      const preview = parseDbtShowPreview(result.logs);
      return c.json({
        success: true,
        preview: {
          ok: result.success && preview !== null,
          exitCode: result.exitCode,
          limit: rowLimit,
          columns: preview?.columns ?? [],
          rows: preview?.rows ?? [],
          node: preview?.node,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to preview dbt model");
    }
  },
);

// Free-form command bar + editor Run menu (dbt Cloud parity). The command is
// tokenized and validated against the same allowlist as stored jobs before it
// reaches the runner, so no extra CLI surface (--profiles-dir, shell
// metachars) leaks in. Runs synchronously against the CALLER's working tree
// (checkout + drafts); warehouse-writing commands are recorded post-hoc into
// dbt_runs so editor runs appear in the Runs history with provenance.
dbtRoutes.post(
  "/projects/:projectId/command",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const parsed = commandSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const { command, environment, defer } = parsed.data;
      // Accept an optional leading "dbt" so users can paste full commands.
      const normalized = command.trim().replace(/^dbt\s+/i, "");
      let validated;
      try {
        validated = parseDbtCommand(normalized);
      } catch (error) {
        if (error instanceof DbtCommandValidationError) {
          return badRequest(c, error.message);
        }
        throw error;
      }
      const userId = getUserId(c);
      const startedAt = new Date();
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        userId,
        command: normalized,
        deferState,
        timeoutMs: 9 * 60 * 1000,
      });

      // Editor/console runs that WROTE to the warehouse join the same run
      // history as agent/job runs. Read-only commands (parse/compile/show)
      // stay ephemeral — recording every live compile would flood the list.
      if (isWarehouseWriteCommand(validated)) {
        const recorded = await recordCompletedAdhocDbtRun({
          workspaceId: project.workspaceId.toString(),
          projectId: project._id.toString(),
          environment: environment ?? project.defaultEnvironment,
          command: normalized,
          triggeredBy: userId,
          workingTreeUserId: userId,
          sourceBranch: await getCheckoutBranch(project, userId),
          deferToProduction: Boolean(defer && deferState),
          startedAt,
          result,
        });
        if (recorded) {
          publishDbtEvent(c, {
            type: "dbt.run.updated",
            projectId: project._id.toString(),
            runId: recorded._id.toString(),
          });
        }
      }

      return c.json({
        success: true,
        result: {
          ok: result.success,
          exitCode: result.exitCode,
          subcommand: validated.subcommand,
          stepResults: result.stepResults,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to run dbt command");
    }
  },
);

// ---------------------------------------------------------------------------
// Lineage — flattened manifest parent_map for the DAG view
// ---------------------------------------------------------------------------

interface ManifestColumn {
  name?: string;
  description?: string;
  data_type?: string | null;
}

interface ManifestNode {
  name?: string;
  resource_type?: string;
  original_file_path?: string;
  description?: string;
  columns?: Record<string, ManifestColumn>;
  tags?: string[];
  config?: { materialized?: string };
}

interface ManifestForLineage {
  nodes?: Record<string, ManifestNode>;
  sources?: Record<
    string,
    {
      name?: string;
      source_name?: string;
      resource_type?: string;
      description?: string;
      columns?: Record<string, ManifestColumn>;
    }
  >;
  exposures?: Record<
    string,
    {
      name?: string;
      label?: string;
      type?: string;
      url?: string;
      description?: string;
      maturity?: string;
      owner?: { name?: string; email?: string };
    }
  >;
  parent_map?: Record<string, string[]>;
}

function mapColumns(
  columns: Record<string, ManifestColumn> | undefined,
): Array<{ name: string; type?: string; description?: string }> {
  if (!columns) return [];
  return Object.values(columns).map(col => ({
    name: col.name ?? "",
    type: col.data_type ?? undefined,
    description: col.description || undefined,
  }));
}

dbtRoutes.get(
  "/projects/:projectId/lineage",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      // Latest run with a manifest artifact wins.
      const run = await DbtRun.findOne({
        projectId: project._id,
        "artifactKeys.manifest": { $exists: true, $ne: null },
      })
        .select("artifactKeys stepResults createdAt")
        .sort({ createdAt: -1 })
        .lean();
      if (!run?.artifactKeys?.manifest) {
        return c.json({
          success: true,
          lineage: { nodes: [], edges: [], generatedAt: null },
        });
      }
      const store = getDashboardArtifactStore();
      const stream = await store.openReadStream(run.artifactKeys.manifest);
      if (!stream) {
        return c.json({ success: false, error: "Manifest not found" }, 404);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const manifest = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ManifestForLineage;

      const statusByUniqueId = new Map(
        (run.stepResults ?? []).map(step => [step.uniqueId, step.status]),
      );

      const includedTypes = new Set(["model", "seed", "snapshot", "source"]);
      const nodes: Array<{
        id: string;
        name: string;
        resourceType: string;
        filePath?: string;
        lastStatus?: string;
        description?: string;
        materialized?: string;
        tags?: string[];
        columns?: Array<{ name: string; type?: string; description?: string }>;
        url?: string;
        owner?: string;
      }> = [];

      for (const [id, node] of Object.entries(manifest.nodes ?? {})) {
        const resourceType = node.resource_type ?? id.split(".")[0];
        if (!includedTypes.has(resourceType)) continue;
        nodes.push({
          id,
          name: node.name ?? id,
          resourceType,
          filePath: node.original_file_path,
          lastStatus: statusByUniqueId.get(id),
          description: node.description || undefined,
          materialized: node.config?.materialized,
          tags: node.tags?.length ? node.tags : undefined,
          columns: mapColumns(node.columns),
        });
      }
      for (const [id, source] of Object.entries(manifest.sources ?? {})) {
        nodes.push({
          id,
          name: source.source_name
            ? `${source.source_name}.${source.name}`
            : (source.name ?? id),
          resourceType: "source",
          description: source.description || undefined,
          columns: mapColumns(source.columns),
        });
      }
      // Exposures are leaf consumers (dashboards/apps) — render them as
      // terminal nodes so the DAG shows what downstream depends on each model.
      for (const [id, exposure] of Object.entries(manifest.exposures ?? {})) {
        nodes.push({
          id,
          name: exposure.label || exposure.name || id,
          resourceType: "exposure",
          description: exposure.description || undefined,
          materialized: exposure.type,
          url: exposure.url,
          owner: exposure.owner?.name || exposure.owner?.email,
        });
      }

      const nodeIds = new Set(nodes.map(node => node.id));
      const edges: Array<{ source: string; target: string }> = [];
      for (const [child, parents] of Object.entries(
        manifest.parent_map ?? {},
      )) {
        if (!nodeIds.has(child)) continue;
        for (const parent of parents) {
          if (!nodeIds.has(parent)) continue;
          edges.push({ source: parent, target: child });
        }
      }

      return c.json({
        success: true,
        lineage: { nodes, edges, generatedAt: run.createdAt },
      });
    } catch (error) {
      return serverError(c, error, "Failed to build dbt lineage");
    }
  },
);
