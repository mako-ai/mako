/** dbt jobs (git is the store: the file is committed before the derived row). */
import { Hono } from "hono";
import { Types } from "mongoose";
import { z } from "zod";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { DbtJob } from "../../database/workspace-schema";
import {
  DbtCommandValidationError,
  parseDbtCommands,
} from "../../dbt/commands";
import {
  commitDbtJobFile,
  deleteDbtJobFile,
  jobScheduleFailure,
  loadLiveJobById,
  loadLiveJobs,
  liveJobToPlain,
  reserveJobSlug,
  resolveLiveJobRow,
} from "../../dbt/dbt-config.service";
import {
  applyJobScheduleChange,
  triggerDbtJobRun,
} from "../../dbt/dbt-run.service";
import { validateScheduledConsoleSchedule } from "../../services/scheduled-query-schedule.service";
import {
  getUserId,
  badRequest,
  serverError,
  publishDbtEvent,
  findProject,
  runActorOf,
} from "./context";
import { fail } from "../lib/respond";

export const dbtJobRoutes = new Hono();

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

dbtJobRoutes.get(
  "/projects/:projectId/jobs",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const jobs = (await loadLiveJobs(project)).map(job =>
        liveJobToPlain(job, project),
      );
      return c.json({ success: true, jobs });
    } catch (error) {
      return serverError(c, error, "Failed to list dbt jobs");
    }
  },
);

dbtJobRoutes.get(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const live = await loadLiveJobById(
        project,
        c.req.param("jobId") as string,
      );
      if (!live) {
        return fail(c, 404, "Job not found");
      }
      return c.json({ success: true, job: liveJobToPlain(live, project) });
    } catch (error) {
      return serverError(c, error, "Failed to get dbt job");
    }
  },
);

dbtJobRoutes.post(
  "/projects/:projectId/jobs",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
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
  },
);

dbtJobRoutes.patch(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const jobId = c.req.param("jobId") as string;
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return fail(c, resolved.status, resolved.error);
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

dbtJobRoutes.delete(
  "/projects/:projectId/jobs/:jobId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const jobId = c.req.param("jobId") as string;
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return fail(c, resolved.status, resolved.error);
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

dbtJobRoutes.post(
  "/projects/:projectId/jobs/:jobId/trigger",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const jobId = c.req.param("jobId") as string;
      if (!Types.ObjectId.isValid(jobId)) {
        return badRequest(c, "Invalid job id");
      }
      const resolved = await resolveLiveJobRow(project, jobId);
      if (!resolved.ok) {
        return fail(c, resolved.status, resolved.error);
      }
      const job = resolved.row;
      const run = await triggerDbtJobRun({
        workspaceId: project.workspaceId.toString(),
        job,
        trigger: "manual",
        triggeredBy: getUserId(c),
        actor: runActorOf(c),
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
