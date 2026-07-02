/**
 * dbt routes — projects, files, jobs, runs, ad-hoc compile/run, lineage.
 *
 * Mounted at `/api/workspaces/:workspaceId/dbt`. Authenticated +
 * workspace-scoped (unifiedAuthMiddleware then the same workspace access
 * check as skills.ts). Business logic lives in api/src/dbt/**.
 */

import { Hono } from "hono";
import { Readable } from "stream";
import { Types } from "mongoose";
import { z } from "zod";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  DbtCheckout,
  DbtFile,
  DbtFileDraft,
  DbtJob,
  DbtProject,
  DbtRun,
  DatabaseConnection,
  GitHubInstallation,
} from "../database/workspace-schema";
import {
  getInstallationToken,
  resolveRepoToken,
} from "../integrations/github/app-auth";
import { signInstallState } from "../integrations/github/install-state";
import {
  getGitHubAppSlug,
  isGitHubAppConfigured,
  getGitHubDevToken,
} from "../integrations/github/config";
import {
  fileExistsAtRef,
  getRepoInfo,
  listBranches,
  listDbtProjectSubdirectories,
  listInstallationRepos,
} from "../integrations/github/github-api";
import {
  fetchRepoDbtFiles,
  repoFilesToInserts,
  syncProjectBranchFromRepo,
} from "../dbt/dbt-github-sync.service";
import {
  closeProjectPullRequest,
  commitAndPush,
  commitToNewBranch,
  createProjectBranch,
  deleteProjectBranch,
  getGitStatus,
  getProjectFileDiff,
  listProjectBranches,
  listProjectPullRequests,
  mergeProjectPullRequest,
  openProjectPullRequest,
  ProtectedBranchError,
  switchProjectBranch,
  updateProjectPullRequest,
} from "../dbt/dbt-github-git.service";
import {
  deleteWorkingFile,
  discardUserDrafts,
  getCheckoutBranch,
  listWorkingFiles,
  readWorkingFile,
  renameWorkingFile,
  writeWorkingFile,
} from "../dbt/dbt-working-tree.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { generateDbtCommitMessage } from "../dbt/dbt-commit-message.service";
import {
  DBT_COMPATIBLE_CONNECTION_TYPES,
  isDbtCompatibleConnectionType,
} from "../dbt/adapter-map";
import { resolveDbtAccess } from "../dbt/rbac";
import {
  DbtCommandValidationError,
  parseDbtCommand,
  parseDbtCommands,
} from "../dbt/commands";
import { buildStarterScaffold } from "../dbt/scaffold";
import { runAdhocDbtCommand } from "../dbt/dbt-project.service";
import {
  applyJobScheduleChange,
  reconcileStaleQueuedRun,
  reconcileStaleQueuedRuns,
  requestDbtRunCancel,
  triggerDbtJobRun,
  triggerDbtRunRetry,
} from "../dbt/dbt-run.service";
import { validateScheduledConsoleSchedule } from "../services/scheduled-query-schedule.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  createVersion,
  getLatestVersionNumber,
  getUserDisplayName,
} from "../services/entity-version.service";

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
  if (error instanceof ProtectedBranchError) {
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

const repoSegmentSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    isValidRepoSegment,
    "must contain only letters, numbers, '.', '_', '-'",
  );

const repoBindingSchema = z.object({
  owner: repoSegmentSchema,
  repo: repoSegmentSchema,
  branch: z.string().min(1).max(255).optional(),
  subdirectory: z.string().max(255).optional(),
  installationId: z.number().int().positive().optional(),
});

const importGithubSchema = z.object({
  name: z.string().min(1).max(128),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1),
  defaultEnvironment: z.string().min(1),
  repo: repoBindingSchema,
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1).optional(),
  defaultEnvironment: z.string().min(1).optional(),
  ci: z
    .object({
      enabled: z.boolean(),
      environment: z.string().min(1).optional(),
      deferToProduction: z.boolean().optional(),
    })
    .optional(),
  /** Branches that refuse direct commits (PR-only). Admin-gated via RBAC. */
  protectedBranches: z
    .array(z.string().min(1).max(255))
    .max(20)
    .optional(),
});

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

// GET / — list projects with job/run rollups for the explorer
dbtRoutes.get("/projects", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const projects = await DbtProject.find({
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .sort({ updatedAt: -1 })
      .lean();
    return c.json({ success: true, projects });
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

    const userId = getUserId(c);
    const project = await DbtProject.create({
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

    const scaffold = buildStarterScaffold(body.name);
    await DbtFile.insertMany(
      scaffold.map(file => ({
        workspaceId: project.workspaceId,
        projectId: project._id,
        path: file.path,
        content: file.content,
        updatedBy: userId,
      })),
    );

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

async function findProject(c: AuthenticatedContext) {
  const workspaceId = c.req.param("workspaceId");
  const projectId = c.req.param("projectId");
  if (
    !workspaceId ||
    !Types.ObjectId.isValid(workspaceId) ||
    !projectId ||
    !Types.ObjectId.isValid(projectId)
  ) {
    return null;
  }
  return DbtProject.findOne({
    _id: new Types.ObjectId(projectId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
}

dbtRoutes.get("/projects/:projectId", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
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
    if (body.ci) {
      if (
        body.ci.environment &&
        !project.environments.some(env => env.name === body.ci?.environment)
      ) {
        return badRequest(
          c,
          `CI environment "${body.ci.environment}" is not in environments`,
        );
      }
      project.ci = {
        enabled: body.ci.enabled,
        environment: body.ci.environment,
        deferToProduction: body.ci.deferToProduction ?? true,
      };
      project.markModified("ci");
    }
    if (body.protectedBranches) {
      if (!project.repo) {
        return badRequest(
          c,
          "Branch protection requires a connected repository",
        );
      }
      project.protectedBranches = [...new Set(body.protectedBranches)];
      project.markModified("protectedBranches");
    }
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

dbtRoutes.delete("/projects/:projectId", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    await Promise.all([
      DbtFile.deleteMany({ projectId: project._id }),
      DbtFileDraft.deleteMany({ projectId: project._id }),
      DbtCheckout.deleteMany({ projectId: project._id }),
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
// GitHub integration — connect a repo, list installation repos, import & sync
// ---------------------------------------------------------------------------

// GET /github/status — tells the UI which connect paths are available.
dbtRoutes.get("/github/status", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  const installations = workspaceId
    ? await GitHubInstallation.find({
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .select("installationId accountLogin accountType repositorySelection")
        .lean()
    : [];
  return c.json({
    success: true,
    appConfigured: isGitHubAppConfigured(),
    appSlug: getGitHubAppSlug() ?? null,
    devTokenAvailable: Boolean(getGitHubDevToken()),
    installations,
  });
});

// GET /github/install-url — URL that starts the GitHub App install flow.
dbtRoutes.get("/github/install-url", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return badRequest(c, "Valid workspace ID is required");
  }
  const slug = getGitHubAppSlug();
  if (!slug) {
    return badRequest(
      c,
      "GitHub App is not configured (set GITHUB_APP_SLUG/GITHUB_APP_ID)",
    );
  }
  // Connecting a repo is a deployment-config mutation → admin+ (consistent with
  // the rbac policy and the /setup callback that consumes this state).
  const user = c.get("user");
  if (!user || !(await workspaceService.isAdmin(workspaceId, user.id))) {
    return c.json(
      {
        success: false,
        error: "Connecting GitHub requires the admin or owner workspace role",
      },
      403,
    );
  }
  const returnClientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  // Signed, short-lived state pins the workspace + initiating user so the
  // /setup callback cannot be forged to bind an arbitrary installation.
  const state = signInstallState({
    workspaceId,
    userId: user.id,
    clientUrl: returnClientUrl,
  });
  return c.json({
    success: true,
    url: `https://github.com/apps/${slug}/installations/new?state=${state}`,
  });
});

// GET /github/repos?installationId= — repos an installation can access.
dbtRoutes.get("/github/repos", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const installationIdRaw = c.req.query("installationId");
    if (!installationIdRaw) {
      return badRequest(c, "installationId is required");
    }
    const installationId = Number(installationIdRaw);
    const installation = await GitHubInstallation.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      installationId,
    });
    if (!installation) {
      return c.json({ success: false, error: "Installation not found" }, 404);
    }
    const token = await getInstallationToken(installationId);
    const repos = await listInstallationRepos(token);
    return c.json({ success: true, repos });
  } catch (error) {
    return serverError(c, error, "Failed to list repositories");
  }
});

// GET /github/branches — branch names for import UI.
dbtRoutes.get("/github/branches", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const owner = c.req.query("owner")?.trim();
    const repo = c.req.query("repo")?.trim();
    if (!owner || !repo) {
      return badRequest(c, "owner and repo are required");
    }
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
      return badRequest(c, "Invalid owner or repo name");
    }
    const installationIdRaw = c.req.query("installationId");
    const installationId = installationIdRaw
      ? Number(installationIdRaw)
      : undefined;
    if (installationIdRaw && Number.isNaN(installationId)) {
      return badRequest(c, "installationId must be a number");
    }
    if (installationId) {
      const installation = await GitHubInstallation.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        installationId,
      });
      if (!installation) {
        return c.json({ success: false, error: "Installation not found" }, 404);
      }
    }
    const token = await resolveRepoToken(installationId);
    const branches = await listBranches(owner, repo, token);
    return c.json({ success: true, branches });
  } catch (error) {
    return serverError(c, error, "Failed to list branches");
  }
});

// GET /github/repo-check — validate dbt_project.yml before import.
dbtRoutes.get("/github/repo-check", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const owner = c.req.query("owner")?.trim();
    const repo = c.req.query("repo")?.trim();
    if (!owner || !repo) {
      return badRequest(c, "owner and repo are required");
    }
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
      return badRequest(c, "Invalid owner or repo name");
    }
    const installationIdRaw = c.req.query("installationId");
    const installationId = installationIdRaw
      ? Number(installationIdRaw)
      : undefined;
    if (installationIdRaw && Number.isNaN(installationId)) {
      return badRequest(c, "installationId must be a number");
    }
    if (installationId) {
      const installation = await GitHubInstallation.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        installationId,
      });
      if (!installation) {
        return c.json({ success: false, error: "Installation not found" }, 404);
      }
    }
    const subdirectory = c.req.query("subdirectory")?.trim() ?? "";
    const token = await resolveRepoToken(installationId);
    const info = await getRepoInfo(owner, repo, token);
    const branch = c.req.query("branch")?.trim() || info.defaultBranch;
    const subdir = subdirectory.replace(/^\/+|\/+$/g, "");
    const projectPath = subdir
      ? `${subdir}/dbt_project.yml`
      : "dbt_project.yml";
    const hasDbtProjectYml = await fileExistsAtRef(
      owner,
      repo,
      projectPath,
      branch,
      token,
    );
    let suggestedSubdirectories: string[] = [];
    if (!hasDbtProjectYml) {
      suggestedSubdirectories = await listDbtProjectSubdirectories(
        owner,
        repo,
        branch,
        token,
      );
    }
    return c.json({
      success: true,
      owner,
      repo,
      branch,
      subdirectory: subdir || undefined,
      defaultBranch: info.defaultBranch,
      hasDbtProjectYml,
      suggestedSubdirectories,
    });
  } catch (error) {
    return serverError(c, error, "Failed to check repository");
  }
});

// POST /projects/import-github — create a project from a repo's contents.
dbtRoutes.post("/projects/import-github", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const parsed = importGithubSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
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

    // SECURITY: never mint an installation token for an installation that is
    // not bound to THIS workspace — otherwise an admin could read any private
    // repo any App installation can see. Mirror the scope check the other
    // GitHub routes (repos/branches/repo-check) already perform.
    if (body.repo.installationId) {
      const installation = await GitHubInstallation.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        installationId: body.repo.installationId,
      });
      if (!installation) {
        return c.json({ success: false, error: "Installation not found" }, 404);
      }
    }

    // Resolve the default branch when the caller didn't pin one, and the
    // repo default branch to seed branch protection.
    const token = await resolveRepoToken(body.repo.installationId);
    const info = await getRepoInfo(body.repo.owner, body.repo.repo, token);
    const branch = body.repo.branch || info.defaultBranch;

    const binding = {
      owner: body.repo.owner,
      repo: body.repo.repo,
      branch,
      subdirectory: body.repo.subdirectory,
      installationId: body.repo.installationId,
    };
    const { sha, files, skippedLarge } = await fetchRepoDbtFiles(binding);

    if (files.length === 0) {
      return badRequest(
        c,
        "No dbt files found in that repo/branch/subdirectory",
      );
    }
    const hasProjectYml = files.some(f => f.path === "dbt_project.yml");
    if (!hasProjectYml) {
      return badRequest(
        c,
        "dbt_project.yml not found at the project root — set the correct subdirectory",
      );
    }

    const userId = getUserId(c);
    const project = await DbtProject.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name,
      dbtVersion: body.dbtVersion ?? "1.9",
      environments: body.environments.map(env => ({
        ...env,
        connectionId: new Types.ObjectId(env.connectionId),
      })),
      defaultEnvironment: body.defaultEnvironment,
      repo: {
        provider: "github" as const,
        installationId: body.repo.installationId,
        owner: binding.owner,
        repo: binding.repo,
        branch: binding.branch,
        subdirectory: body.repo.subdirectory,
        lastSyncedSha: sha,
        lastSyncedAt: new Date(),
      },
      // New imports protect the repo's default branch out of the box: prod
      // changes go through a PR (commit-to-branch → open PR → merge).
      protectedBranches: [info.defaultBranch],
      createdBy: userId,
    });

    await DbtFile.insertMany(
      repoFilesToInserts(files, {
        workspaceId: project.workspaceId,
        projectId: project._id,
        branch: binding.branch,
        updatedBy: userId,
      }),
    );

    publishDbtEvent(c, {
      type: "dbt.project.updated",
      projectId: project._id.toString(),
    });
    return c.json({
      success: true,
      project,
      imported: files.length,
      skippedLarge,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return badRequest(c, "A dbt project with this name already exists");
    }
    return serverError(c, error, "Failed to import dbt project from GitHub");
  }
});

// POST /projects/:projectId/sync — pull the caller's checkout branch into its
// committed base tree. Always safe: drafts (uncommitted per-user work) live in
// a separate overlay. `?discard=true` additionally drops the CALLER's drafts
// (a `git checkout -- .` before the pull).
dbtRoutes.post("/projects/:projectId/sync", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    if (!project.repo) {
      return badRequest(c, "Project is not connected to a repository");
    }
    const userId = getUserId(c);
    if (c.req.query("discard") === "true") {
      await discardUserDrafts(project, userId);
    }
    const branch = (await getCheckoutBranch(project, userId)) as string;
    const result = await syncProjectBranchFromRepo(project, branch, userId);
    publishDbtEvent(c, {
      type: "dbt.git.updated",
      projectId: project._id.toString(),
      updatedBy: userId,
    });
    return c.json({ success: true, ...result, branch, project });
  } catch (error) {
    return serverError(c, error, "Failed to sync dbt project from GitHub");
  }
});

// ---------------------------------------------------------------------------
// In-IDE git: status, commit & push, branches, pull requests
// ---------------------------------------------------------------------------

const commitSchema = z.object({ message: z.string().min(1).max(500) });
const branchNameField = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, "Invalid branch name");
const branchSchema = z.object({ name: branchNameField });
const commitToBranchSchema = z.object({
  name: branchNameField,
  message: z.string().min(1).max(500),
});
const switchBranchSchema = z.object({
  branch: z.string().min(1).max(255),
  discardLocalChanges: z.boolean().optional(),
});
const pullRequestSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().max(10_000).optional(),
  base: z.string().min(1).max(255).optional(),
});
const updatePullRequestSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    body: z.string().max(10_000).optional(),
    base: z.string().min(1).max(255).optional(),
  })
  .refine(
    data =>
      data.title !== undefined ||
      data.body !== undefined ||
      data.base !== undefined,
    { message: "Provide at least one of title, body, or base" },
  );
const closePullRequestSchema = z.object({
  deleteBranch: z.boolean().optional(),
});
const listPullRequestsQuerySchema = z
  .enum(["open", "closed", "all"])
  .default("open");

// GET /projects/:projectId/git/status — the CALLER's working-tree diff (their
// drafts vs the committed base of their checked-out branch).
dbtRoutes.get(
  "/projects/:projectId/git/status",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const status = await getGitStatus(project, getUserId(c));
      return c.json({
        success: true,
        status,
        protectedBranches: project.protectedBranches ?? [],
      });
    } catch (error) {
      return serverError(c, error, "Failed to compute git status");
    }
  },
);

// GET /projects/:projectId/git/diff?path= — committed base vs the caller's
// draft content.
dbtRoutes.get(
  "/projects/:projectId/git/diff",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const path = c.req.query("path");
      if (!path) {
        return badRequest(c, "path query parameter is required");
      }
      const diff = await getProjectFileDiff(project, getUserId(c), path);
      return c.json({ success: true, diff });
    } catch (error) {
      return serverError(c, error, "Failed to compute git diff");
    }
  },
);

// POST /projects/:projectId/git/commit — commit & push the caller's drafts to
// their checked-out branch. Refuses protected branches (400).
dbtRoutes.post(
  "/projects/:projectId/git/commit",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = commitSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const userId = getUserId(c);
      const result = await commitAndPush(project, {
        userId,
        message: parsed.data.message,
        updatedBy: userId,
      });
      if (result.committed) {
        publishDbtEvent(c, {
          type: "dbt.git.updated",
          projectId: project._id.toString(),
          updatedBy: userId,
        });
      }
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to commit and push");
    }
  },
);

// POST /projects/:projectId/git/commit-message — AI-generate a commit message
// from the working-tree diff. Returns { message: null } when there are no
// changes or generation is unavailable; the client keeps the manual field.
dbtRoutes.post(
  "/projects/:projectId/git/commit-message",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const user = c.get("user");
      const message = await generateDbtCommitMessage(project, {
        workspaceId: c.req.param("workspaceId") ?? "unknown",
        userId: getUserId(c),
        userEmail: user?.email,
      });
      return c.json({ success: true, message });
    } catch (error) {
      return serverError(c, error, "Failed to generate commit message");
    }
  },
);

// GET /projects/:projectId/git/branches — list remote branches; `current` is
// the CALLER's checkout, not a shared project pointer.
dbtRoutes.get(
  "/projects/:projectId/git/branches",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const [branches, current] = await Promise.all([
        listProjectBranches(project),
        getCheckoutBranch(project, getUserId(c)),
      ]);
      return c.json({
        success: true,
        branches,
        current,
        protectedBranches: project.protectedBranches ?? [],
      });
    } catch (error) {
      return serverError(c, error, "Failed to list branches");
    }
  },
);

// POST /projects/:projectId/git/branch — create a branch off the caller's
// checkout HEAD and check it out for them (only their checkout moves).
dbtRoutes.post(
  "/projects/:projectId/git/branch",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = branchSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const userId = getUserId(c);
      const result = await createProjectBranch(
        project,
        userId,
        parsed.data.name,
      );
      publishDbtEvent(c, {
        type: "dbt.checkout.updated",
        projectId: project._id.toString(),
        branch: result.branch,
        forUserId: userId,
        updatedBy: userId,
      });
      return c.json({ success: true, ...result, project });
    } catch (error) {
      return serverError(c, error, "Failed to create branch");
    }
  },
);

// POST /projects/:projectId/git/commit-to-branch — atomic create-branch +
// commit the caller's drafts onto it (race-free promote; the protected-branch
// escape hatch).
dbtRoutes.post(
  "/projects/:projectId/git/commit-to-branch",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = commitToBranchSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const userId = getUserId(c);
      const result = await commitToNewBranch(project, {
        userId,
        branchName: parsed.data.name,
        message: parsed.data.message,
        updatedBy: userId,
      });
      publishDbtEvent(c, {
        type: "dbt.checkout.updated",
        projectId: project._id.toString(),
        branch: result.branch,
        forUserId: userId,
        updatedBy: userId,
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to commit to new branch");
    }
  },
);

// DELETE /projects/:projectId/git/branch/:name — delete a remote branch.
dbtRoutes.delete(
  "/projects/:projectId/git/branch/:name",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const name = c.req.param("name");
      if (!name) {
        return badRequest(c, "Branch name is required");
      }
      const userId = getUserId(c);
      const result = await deleteProjectBranch(
        project,
        userId,
        decodeURIComponent(name),
      );
      publishDbtEvent(c, {
        type: "dbt.git.updated",
        projectId: project._id.toString(),
        updatedBy: userId,
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to delete branch");
    }
  },
);

// POST /projects/:projectId/git/switch-branch — move the CALLER's checkout to
// another branch. Their drafts carry over as an overlay (nothing is lost);
// discardLocalChanges drops the caller's drafts instead.
dbtRoutes.post(
  "/projects/:projectId/git/switch-branch",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = switchBranchSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const userId = getUserId(c);
      const result = await switchProjectBranch(
        project,
        userId,
        parsed.data.branch,
        userId,
        { discardLocalChanges: parsed.data.discardLocalChanges ?? false },
      );
      publishDbtEvent(c, {
        type: "dbt.checkout.updated",
        projectId: project._id.toString(),
        branch: result.branch,
        forUserId: userId,
        updatedBy: userId,
      });
      return c.json({ success: true, ...result, project });
    } catch (error) {
      return serverError(c, error, "Failed to switch branch");
    }
  },
);

// POST /projects/:projectId/git/pull-request — open a PR from the caller's
// checked-out branch.
dbtRoutes.post(
  "/projects/:projectId/git/pull-request",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = pullRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const result = await openProjectPullRequest(
        project,
        getUserId(c),
        parsed.data,
      );
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to open pull request");
    }
  },
);

const mergePullRequestSchema = z.object({
  prNumber: z.number().int().positive(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  deleteBranch: z.boolean().optional(),
});

// POST /projects/:projectId/git/merge-pull-request — merge a PR (the only
// write path into protected branches). Admin+ via the RBAC policy.
dbtRoutes.post(
  "/projects/:projectId/git/merge-pull-request",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = mergePullRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const userId = getUserId(c);
      const result = await mergeProjectPullRequest(project, {
        userId,
        prNumber: parsed.data.prNumber,
        mergeMethod: parsed.data.mergeMethod,
        deleteBranch: parsed.data.deleteBranch,
        updatedBy: userId,
      });
      publishDbtEvent(c, {
        type: "dbt.git.updated",
        projectId: project._id.toString(),
        updatedBy: userId,
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to merge pull request");
    }
  },
);

function parsePrNumber(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const num = Number(raw);
  return num > 0 ? num : null;
}

// GET /projects/:projectId/git/pull-requests?state=open|closed|all — list the
// repo's PRs (newest first).
dbtRoutes.get(
  "/projects/:projectId/git/pull-requests",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const parsed = listPullRequestsQuerySchema.safeParse(
        c.req.query("state") ?? undefined,
      );
      if (!parsed.success) {
        return badRequest(c, "state must be one of open, closed, all");
      }
      const pullRequests = await listProjectPullRequests(project, {
        state: parsed.data,
      });
      return c.json({ success: true, pullRequests });
    } catch (error) {
      return serverError(c, error, "Failed to list pull requests");
    }
  },
);

// PATCH /projects/:projectId/git/pull-request/:number — update an open PR's
// title/body/base.
dbtRoutes.patch(
  "/projects/:projectId/git/pull-request/:number",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const prNumber = parsePrNumber(c.req.param("number"));
      if (!prNumber) {
        return badRequest(c, "Invalid pull request number");
      }
      const parsed = updatePullRequestSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const pr = await updateProjectPullRequest(project, {
        prNumber,
        ...parsed.data,
      });
      return c.json({ success: true, pr });
    } catch (error) {
      return serverError(c, error, "Failed to update pull request");
    }
  },
);

// POST /projects/:projectId/git/pull-request/:number/close — close a PR
// without merging, optionally deleting its source branch.
dbtRoutes.post(
  "/projects/:projectId/git/pull-request/:number/close",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      if (!project.repo) {
        return badRequest(c, "Project is not connected to a repository");
      }
      const prNumber = parsePrNumber(c.req.param("number"));
      if (!prNumber) {
        return badRequest(c, "Invalid pull request number");
      }
      const body = await c.req.json().catch(() => ({}));
      const parsed = closePullRequestSchema.safeParse(body);
      if (!parsed.success) {
        return badRequest(c, parsed.error.issues[0]?.message ?? "Invalid body");
      }
      const result = await closeProjectPullRequest(project, {
        prNumber,
        deleteBranch: parsed.data.deleteBranch,
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      return serverError(c, error, "Failed to close pull request");
    }
  },
);

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

// File reads/writes go through the per-user working tree: repo projects
// merge the caller's draft overlay over the committed base of their checkout
// branch, so uncommitted edits are only visible to their author.

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
      const { versionEntityId } = await writeWorkingFile(
        project,
        userId,
        path,
        body.content,
      );

      // Version snapshot (entity-version pattern) — undo/version history.
      try {
        const latest = await getLatestVersionNumber(versionEntityId, "dbt-file");
        await createVersion({
          entityType: "dbt-file",
          entityId: versionEntityId,
          workspaceId: project.workspaceId,
          snapshot: { path, content: body.content },
          savedBy: userId,
          savedByName: await getUserDisplayName(userId),
          comment: `Save ${path} (v${latest + 1})`,
        });
      } catch (versionError) {
        logger.warn("dbt file version snapshot failed", {
          error: versionError,
        });
      }

      await DbtProject.updateOne(
        { _id: project._id },
        { $currentDate: { updatedAt: true } },
      );
      // Draft edits poke only the author's other windows (forUserId); blank
      // projects stay workspace-wide (shared tree).
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path,
        updatedBy: userId,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        origin: "save",
        forUserId: project.repo ? userId : undefined,
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
        forUserId: project.repo ? userId : undefined,
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
      const body = (await c.req.json()) as { from?: unknown; to?: unknown };
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
  }
  return null;
}

dbtRoutes.get("/projects/:projectId/jobs", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const jobs = await DbtJob.find({ projectId: project._id })
      .sort({ createdAt: 1 })
      .lean();
    return c.json({ success: true, jobs });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt jobs");
  }
});

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

    const job = await DbtJob.create({
      workspaceId: project.workspaceId,
      projectId: project._id,
      name: parsed.data.name,
      environment: parsed.data.environment,
      commands: parsed.data.commands,
      schedule: parsed.data.schedule ?? undefined,
      enabled: parsed.data.enabled,
      deferToProduction: parsed.data.deferToProduction,
      createdBy: getUserId(c),
    });
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
      const job = await DbtJob.findOne({
        _id: new Types.ObjectId(jobId),
        projectId: project._id,
      });
      if (!job) {
        return c.json({ success: false, error: "Job not found" }, 404);
      }
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
      const result = await DbtJob.deleteOne({
        _id: new Types.ObjectId(jobId),
        projectId: project._id,
      });
      if (result.deletedCount === 0) {
        return c.json({ success: false, error: "Job not found" }, 404);
      }
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
      const job = await DbtJob.findOne({
        _id: new Types.ObjectId(jobId),
        projectId: project._id,
      });
      if (!job) {
        return c.json({ success: false, error: "Job not found" }, 404);
      }
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
// Ad-hoc compile / run-select (synchronous runner invocations)
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

const SELECT_PATTERN = /^[\w.+@:*\-/]+$/;

/**
 * Read the project's last production manifest for `--defer --state`, or
 * `undefined` when defer is off / no prod build exists yet. Never throws —
 * a missing manifest just disables defer for this invocation.
 */
async function loadDeferState(project: {
  lastProdManifestKey?: string;
}): Promise<Buffer | undefined> {
  const key = project.lastProdManifestKey;
  if (!key) return undefined;
  try {
    const stream = await getDashboardArtifactStore().openReadStream(key);
    if (!stream) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    logger.warn("Failed to load defer state manifest", { error, key });
    return undefined;
  }
}

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

dbtRoutes.post(
  "/projects/:projectId/run-select",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return c.json({ success: false, error: "dbt project not found" }, 404);
      }
      const parsed = adhocSchema.safeParse(await c.req.json());
      if (!parsed.success || !parsed.data.select) {
        return badRequest(c, "select is required");
      }
      const { select, environment, defer } = parsed.data;
      if (!SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        userId: getUserId(c),
        command: `build --select ${select}`,
        select,
        deferState,
        timeoutMs: 5 * 60 * 1000,
      });
      return c.json({
        success: true,
        run: {
          ok: result.success,
          exitCode: result.exitCode,
          stepResults: result.stepResults,
          logs: noteDeferUnavailable(result.logs, !!defer, deferState),
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to run dbt model");
    }
  },
);

// Free-form command bar (dbt Cloud parity). The command is tokenized and
// validated against the same allowlist as stored jobs before it reaches the
// runner, so no extra CLI surface (--profiles-dir, shell metachars) leaks in.
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
      const deferState = defer ? await loadDeferState(project) : undefined;
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        userId: getUserId(c),
        command: normalized,
        deferState,
        timeoutMs: 9 * 60 * 1000,
      });
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
