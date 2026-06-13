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
  DbtFile,
  DbtJob,
  DbtProject,
  DbtRun,
  DatabaseConnection,
} from "../database/workspace-schema";
import {
  DBT_COMPATIBLE_CONNECTION_TYPES,
  isDbtCompatibleConnectionType,
} from "../dbt/adapter-map";
import { DbtCommandValidationError, parseDbtCommands } from "../dbt/commands";
import { buildStarterScaffold } from "../dbt/scaffold";
import { runAdhocDbtCommand } from "../dbt/dbt-project.service";
import {
  applyJobScheduleChange,
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

// Workspace access check — mirrors skills.ts
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
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
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
  logger.error(fallback, { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : fallback,
    },
    500,
  );
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

const patchProjectSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1).optional(),
  defaultEnvironment: z.string().min(1).optional(),
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
    await project.save();
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
      DbtJob.deleteMany({ projectId: project._id }),
      DbtRun.deleteMany({ projectId: project._id }),
    ]);
    await project.deleteOne();
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

dbtRoutes.get("/projects/:projectId/files", async (c: AuthenticatedContext) => {
  try {
    const project = await findProject(c);
    if (!project) {
      return c.json({ success: false, error: "dbt project not found" }, 404);
    }
    const files = await DbtFile.find({
      projectId: project._id,
      is_deleted: { $ne: true },
    })
      .select("path updatedAt updatedBy")
      .sort({ path: 1 })
      .lean();
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
      const file = await DbtFile.findOne({
        projectId: project._id,
        path,
        is_deleted: { $ne: true },
      }).lean();
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

      const body = (await c.req.json()) as { content?: unknown };
      if (typeof body.content !== "string") {
        return badRequest(c, "content (string) is required");
      }
      if (body.content.length > 1_000_000) {
        return badRequest(c, "File too large (max 1MB)");
      }

      const userId = getUserId(c);
      const file = await DbtFile.findOneAndUpdate(
        { projectId: project._id, path },
        {
          $set: {
            content: body.content,
            updatedBy: userId,
            is_deleted: false,
            workspaceId: project.workspaceId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Version snapshot (entity-version pattern) — undo/version history.
      try {
        const latest = await getLatestVersionNumber(file._id, "dbt-file");
        await createVersion({
          entityType: "dbt-file",
          entityId: file._id,
          workspaceId: project.workspaceId,
          snapshot: { path: file.path, content: body.content },
          savedBy: userId,
          savedByName: await getUserDisplayName(userId),
          comment: `Save ${file.path} (v${latest + 1})`,
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
      return c.json({ success: true, file });
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
      const result = await DbtFile.updateOne(
        { projectId: project._id, path },
        { $set: { is_deleted: true, updatedBy: getUserId(c) } },
      );
      if (result.matchedCount === 0) {
        return c.json({ success: false, error: "File not found" }, 404);
      }
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
      const existing = await DbtFile.findOne({
        projectId: project._id,
        path: to,
        is_deleted: { $ne: true },
      });
      if (existing) return badRequest(c, `"${to}" already exists`);

      // Replace any soft-deleted doc occupying the target path.
      await DbtFile.deleteOne({ projectId: project._id, path: to });
      const result = await DbtFile.updateOne(
        { projectId: project._id, path: from, is_deleted: { $ne: true } },
        { $set: { path: to, updatedBy: getUserId(c) } },
      );
      if (result.matchedCount === 0) {
        return c.json({ success: false, error: "File not found" }, 404);
      }
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
    return c.json({ success: true, runs });
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
      const run = await DbtRun.findOne({
        _id: new Types.ObjectId(runId),
        projectId: project._id,
      }).lean();
      if (!run) {
        return c.json({ success: false, error: "Run not found" }, 404);
      }
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
      const cancelled = await requestDbtRunCancel({
        workspaceId: project.workspaceId.toString(),
        runId,
      });
      if (!cancelled) {
        return badRequest(c, "Run is not cancellable (already finished?)");
      }
      return c.json({ success: true });
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
});

const SELECT_PATTERN = /^[\w.+@:*\-/]+$/;

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
      const { select, environment } = parsed.data;
      if (select && !SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const command = select ? `compile --select ${select}` : "parse";
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        command,
        select,
        timeoutMs: 3 * 60 * 1000,
      });
      return c.json({
        success: true,
        compile: {
          ok: result.success,
          exitCode: result.exitCode,
          compiledSql: result.compiledSql,
          logs: result.logs,
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
      const { select, environment } = parsed.data;
      if (!SELECT_PATTERN.test(select)) {
        return badRequest(c, "Invalid --select value");
      }
      const result = await runAdhocDbtCommand({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        environmentName: environment,
        command: `build --select ${select}`,
        select,
        timeoutMs: 5 * 60 * 1000,
      });
      return c.json({
        success: true,
        run: {
          ok: result.success,
          exitCode: result.exitCode,
          stepResults: result.stepResults,
          logs: result.logs,
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to run dbt model");
    }
  },
);

// ---------------------------------------------------------------------------
// Lineage — flattened manifest parent_map for the DAG view
// ---------------------------------------------------------------------------

interface ManifestForLineage {
  nodes?: Record<
    string,
    {
      name?: string;
      resource_type?: string;
      original_file_path?: string;
    }
  >;
  sources?: Record<
    string,
    { name?: string; source_name?: string; resource_type?: string }
  >;
  parent_map?: Record<string, string[]>;
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
        });
      }
      for (const [id, source] of Object.entries(manifest.sources ?? {})) {
        nodes.push({
          id,
          name: source.source_name
            ? `${source.source_name}.${source.name}`
            : (source.name ?? id),
          resourceType: "source",
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
