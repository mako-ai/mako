/**
 * Server-side dbt verification tools.
 *
 * The agent edits dbt files through the CLIENT tools (create_dbt_file /
 * modify_dbt_file in @mako/agent-tools) and then verifies its work here:
 *   dbt_parse          — project-wide validation after YAML edits
 *   dbt_compile_model  — Jinja render check, returns compiled SQL
 *   dbt_run_model      — `build --select <model>` on the dev environment,
 *                        returns step results incl. test outcomes
 *   dbt_run_job        — trigger a saved job (requires explicit user
 *                        confirmation in the prompt, like schedule_query)
 *
 * All tools go through the same workspace-scoped ad-hoc service path as the
 * IDE buttons (api/src/dbt/dbt-project.service.ts).
 */

import { tool } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  DbtFile,
  DbtJob,
  DbtProject,
  DbtRun,
} from "../../database/workspace-schema";
import { runAdhocDbtCommand } from "../../dbt/dbt-project.service";
import {
  applyJobScheduleChange,
  triggerDbtJobRun,
} from "../../dbt/dbt-run.service";
import {
  DbtCommandValidationError,
  parseDbtCommands,
} from "../../dbt/commands";
import {
  DBT_COMPATIBLE_CONNECTION_TYPES,
  isDbtCompatibleConnectionType,
} from "../../dbt/adapter-map";
import { buildStarterScaffold } from "../../dbt/scaffold";
import { validateScheduledConsoleSchedule } from "../../services/scheduled-query-schedule.service";
import type { DbtLogLine } from "../../dbt/runner.service";

/**
 * A single dbt node name (e.g. `stg_orders`) OR a dbt selector with graph
 * operators / methods, e.g. `+stg_orders`, `stg_orders+`, `tag:nightly`,
 * `path:models/staging`, `state:modified+`, `source:raw.orders+`, `a,b`.
 * Disallows whitespace and shell metacharacters so it can never inject extra
 * argv tokens (args are passed to spawn without a shell).
 */
const SELECTOR_PATTERN = /^[\w.@:+*/,-]+$/;

const projectIdField = z
  .string()
  .describe("dbt project ID (from read_dbt_project_tree)");

function toolError(error: unknown, fallback: string) {
  return {
    success: false,
    error: error instanceof Error ? error.message : fallback,
  };
}

/** Keep tool outputs small: errors + warnings + last few info lines. */
function summarizeLogs(logs: DbtLogLine[], maxLines = 30): string[] {
  const important = logs.filter(
    log => log.level === "error" || log.level === "warn",
  );
  const rest = logs.filter(
    log => log.level !== "error" && log.level !== "warn",
  );
  const selected = [...important, ...rest.slice(-10)].slice(0, maxLines);
  return selected.map(log => `[${log.level}] ${log.line}`);
}

export const createDbtServerTools = (workspaceId: string) => {
  const assertProject = async (projectId: string) => {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new Error("Invalid dbt project id");
    }
    const project = await DbtProject.findOne({
      _id: new Types.ObjectId(projectId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!project) throw new Error("dbt project not found or access denied");
    return project;
  };

  /**
   * Validate a job's environment, commands (allowlist), and optional schedule.
   * Mirrors validateJobBody in dbt.routes.ts. Returns an error string or null.
   */
  const validateJob = (
    project: { environments: Array<{ name: string }> },
    job: {
      environment: string;
      commands: string[];
      schedule?: { cron: string; timezone: string } | null;
    },
  ): string | null => {
    if (!project.environments.some(env => env.name === job.environment)) {
      return `Environment "${job.environment}" not found on project`;
    }
    try {
      parseDbtCommands(job.commands);
    } catch (error) {
      if (error instanceof DbtCommandValidationError) return error.message;
      throw error;
    }
    if (job.schedule) {
      try {
        validateScheduledConsoleSchedule(job.schedule);
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid schedule";
      }
    }
    return null;
  };

  return {
    dbt_create_project: tool({
      description:
        "Initialize a new dbt project in this workspace. Use this when " +
        'read_dbt_project_tree returns no projects ({"projects": []}) and you ' +
        "need to start building transforms. Creates the project with one " +
        "environment pointing at a warehouse connection, scaffolds starter " +
        "files (dbt_project.yml, example model, schema.yml), and returns the " +
        "projectId to pass to every other dbt tool. Pick the warehouse " +
        "connection with list_connections / sql_list_connections first.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(128)
          .describe("Project name, e.g. 'analytics'"),
        connectionId: z
          .string()
          .describe(
            "DatabaseConnection id for the warehouse dbt builds into " +
              "(from list_connections / sql_list_connections). Must be a " +
              `dbt-compatible type: ${DBT_COMPATIBLE_CONNECTION_TYPES.join(", ")}.`,
          ),
        targetSchema: z
          .string()
          .min(1)
          .max(128)
          .default("dbt_dev")
          .describe("Schema/dataset dbt builds into (default dbt_dev)"),
        environmentName: z
          .string()
          .min(1)
          .max(64)
          .default("dev")
          .describe("Environment name (default dev)"),
        dbtVersion: z.string().max(16).optional(),
      }),
      execute: async ({
        name,
        connectionId,
        targetSchema,
        environmentName,
        dbtVersion,
      }) => {
        try {
          if (!Types.ObjectId.isValid(connectionId)) {
            return { success: false, error: "Invalid connection id" };
          }
          const connection = await DatabaseConnection.findOne({
            _id: new Types.ObjectId(connectionId),
            workspaceId: new Types.ObjectId(workspaceId),
          }).select("type");
          if (!connection) {
            return {
              success: false,
              error: "Connection not found or access denied",
            };
          }
          if (!isDbtCompatibleConnectionType(connection.type)) {
            return {
              success: false,
              error:
                `Connection type "${connection.type}" is not dbt-compatible. ` +
                `Supported: ${DBT_COMPATIBLE_CONNECTION_TYPES.join(", ")}`,
            };
          }

          const project = await DbtProject.create({
            workspaceId: new Types.ObjectId(workspaceId),
            name,
            dbtVersion: dbtVersion ?? "1.9",
            environments: [
              {
                name: environmentName,
                connectionId: connection._id,
                targetSchema,
                threads: 4,
              },
            ],
            defaultEnvironment: environmentName,
            createdBy: "agent",
          });

          const scaffold = buildStarterScaffold(name);
          await DbtFile.insertMany(
            scaffold.map(file => ({
              workspaceId: project.workspaceId,
              projectId: project._id,
              path: file.path,
              content: file.content,
              updatedBy: "agent",
            })),
          );

          return {
            success: true,
            projectId: project._id.toString(),
            name: project.name,
            environment: environmentName,
            targetSchema,
            scaffoldedFiles: scaffold.map(file => file.path),
            message:
              "Project created. Call read_dbt_project_tree to see the " +
              "scaffolded files, then build your models.",
          };
        } catch (error) {
          if ((error as { code?: number }).code === 11000) {
            return {
              success: false,
              error: "A dbt project with this name already exists",
            };
          }
          return toolError(error, "Failed to create dbt project");
        }
      },
    }),

    dbt_parse: tool({
      description:
        "Validate the entire dbt project (dbt parse): catches Jinja errors, " +
        "bad refs/sources, and schema.yml problems WITHOUT touching the " +
        "warehouse. Run this after editing YAML or multiple files.",
      inputSchema: z.object({
        projectId: projectIdField,
        environment: z
          .string()
          .optional()
          .describe("Environment name; defaults to the project default (dev)"),
      }),
      execute: async ({ projectId, environment }) => {
        try {
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: "parse",
            timeoutMs: 2 * 60 * 1000,
          });
          return {
            success: result.success,
            ...(result.success
              ? { message: "Project parsed successfully" }
              : { error: "dbt parse failed" }),
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to run dbt parse");
        }
      },
    }),

    dbt_compile_model: tool({
      description:
        "Compile dbt nodes (dbt compile --select <selector>) and return the " +
        "rendered SQL for a single model, or the Jinja/compilation error. No " +
        "warehouse writes. `model` accepts a node name (stg_orders) or a dbt " +
        "selector with graph operators/methods (+stg_orders, tag:nightly, " +
        "path:models/staging). Use after writing or editing a model.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe(
            "Node name (stg_orders) or dbt selector (+stg_orders, tag:nightly)",
          ),
        environment: z.string().optional(),
      }),
      execute: async ({ projectId, model, environment }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: `compile --select ${model}`,
            select: model,
            timeoutMs: 3 * 60 * 1000,
          });
          return {
            success: result.success,
            compiledSql: result.compiledSql,
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to compile model");
        }
      },
    }),

    dbt_run_model: tool({
      description:
        "Build dbt nodes AND their tests (dbt build --select <selector>) " +
        "against the project's dev environment (or the given environment). " +
        "This WRITES to the warehouse target schema. `model` accepts a node " +
        "name (stg_orders) or a dbt selector with graph operators/methods " +
        "(stg_orders+, +marts.orders, tag:nightly, state:modified+). Returns " +
        "per-node status, timing, rows affected, and test pass/fail outcomes. " +
        "Use this as the final verification after compile succeeds.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe(
            "Node name (stg_orders) or dbt selector (stg_orders+, tag:nightly)",
          ),
        environment: z
          .string()
          .optional()
          .describe(
            "Environment name; defaults to the project default (dev). Only " +
              "use prod when the user explicitly asks.",
          ),
      }),
      execute: async ({ projectId, model, environment }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: `build --select ${model}`,
            select: model,
            timeoutMs: 5 * 60 * 1000,
          });
          return {
            success: result.success,
            stepResults: result.stepResults,
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to run model");
        }
      },
    }),

    dbt_run_job: tool({
      description:
        "Trigger a saved dbt job (full command list, possibly against prod). " +
        "Runs asynchronously via the job runner; returns the runId to share " +
        "with the user. Only call after the user explicitly confirms which " +
        "job to run — never trigger prod jobs proactively.",
      inputSchema: z.object({
        projectId: projectIdField,
        jobId: z.string().describe("dbt job ID (from read_dbt_project_tree)"),
      }),
      execute: async ({ projectId, jobId }) => {
        try {
          const project = await assertProject(projectId);
          if (!Types.ObjectId.isValid(jobId)) {
            return { success: false, error: "Invalid job id" };
          }
          const job = await DbtJob.findOne({
            _id: new Types.ObjectId(jobId),
            projectId: project._id,
          });
          if (!job) return { success: false, error: "Job not found" };
          const run = await triggerDbtJobRun({
            workspaceId,
            job,
            trigger: "agent",
            triggeredBy: "agent",
          });
          return {
            success: true,
            runId: run._id.toString(),
            jobName: job.name,
            environment: job.environment,
            commands: job.commands,
            message:
              "Run queued. The user can watch live logs in the job tab " +
              "(Transforms → Jobs).",
          };
        } catch (error) {
          return toolError(error, "Failed to trigger job");
        }
      },
    }),

    dbt_get_run: tool({
      description:
        "Read the status, step results, and logs of a dbt run — use this " +
        "AFTER dbt_run_job to see whether the run passed or failed (the " +
        "trigger only queues it). Pass `runId` for a specific run, or `jobId` " +
        "to get that job's most recent run.",
      inputSchema: z.object({
        projectId: projectIdField,
        runId: z.string().optional().describe("dbt run ID (from dbt_run_job)"),
        jobId: z
          .string()
          .optional()
          .describe("dbt job ID — returns the latest run for this job"),
      }),
      execute: async ({ projectId, runId, jobId }) => {
        try {
          const project = await assertProject(projectId);
          if (!runId && !jobId) {
            return { success: false, error: "Provide runId or jobId" };
          }

          const query: Record<string, unknown> = {
            workspaceId: new Types.ObjectId(workspaceId),
            projectId: project._id,
          };
          if (runId) {
            if (!Types.ObjectId.isValid(runId)) {
              return { success: false, error: "Invalid run id" };
            }
            query._id = new Types.ObjectId(runId);
          } else if (jobId) {
            if (!Types.ObjectId.isValid(jobId)) {
              return { success: false, error: "Invalid job id" };
            }
            query.jobId = new Types.ObjectId(jobId);
          }

          const run = await DbtRun.findOne(query)
            .sort({ createdAt: -1 })
            .lean();
          if (!run) return { success: false, error: "Run not found" };

          return {
            success: true,
            runId: run._id.toString(),
            status: run.status,
            trigger: run.trigger,
            environment: run.environment,
            commands: run.commands,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            durationMs: run.durationMs,
            error: run.error,
            stepResults: (run.stepResults ?? []).map(step => ({
              name: step.name,
              resourceType: step.resourceType,
              status: step.status,
              executionTimeMs: step.executionTimeMs,
              rowsAffected: step.rowsAffected,
              message: step.message,
            })),
            logs: summarizeLogs(
              (run.logs ?? []).map(log => ({
                ts: log.ts,
                level: log.level,
                line: log.line,
              })) as DbtLogLine[],
            ),
          };
        } catch (error) {
          return toolError(error, "Failed to read dbt run");
        }
      },
    }),

    dbt_show: tool({
      description:
        "Preview the rows a model/selector would return (dbt show --select " +
        "<selector> --limit N) WITHOUT materializing it. Runs a bounded " +
        "SELECT against the environment; no warehouse writes. Use to validate " +
        "that a transform produces the expected output.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe("Node name (stg_orders) or dbt selector (+stg_orders)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(5)
          .describe("Max rows to preview (default 5)"),
        environment: z.string().optional(),
      }),
      execute: async ({ projectId, model, limit, environment }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          await assertProject(projectId);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: environment,
            command: `show --select ${model} --limit ${limit}`,
            timeoutMs: 3 * 60 * 1000,
          });
          // The preview table arrives as info-level log line(s) (ShowNode);
          // anchor on the "Previewing" marker to drop dbt startup boilerplate,
          // falling back to all info lines if the marker text ever changes.
          const infoLines = result.logs
            .filter(log => log.level === "info")
            .map(log => log.line);
          const markerIdx = infoLines.findIndex(line =>
            line.includes("Previewing"),
          );
          const preview = (
            markerIdx >= 0 ? infoLines.slice(markerIdx) : infoLines
          )
            .join("\n")
            .slice(0, 8000);
          if (!result.success) {
            const reason = result.logs
              .filter(log => log.level === "error")
              .map(log => log.line)
              .join("\n");
            return {
              success: false,
              error: reason || "dbt show failed",
              logs: summarizeLogs(result.logs),
            };
          }
          return {
            success: true,
            preview,
            logs: summarizeLogs(result.logs),
          };
        } catch (error) {
          return toolError(error, "Failed to preview model");
        }
      },
    }),

    dbt_create_job: tool({
      description:
        "Create a saved dbt job (a named command list, optionally scheduled). " +
        "Commands are validated against the dbt allowlist. Provide a cron " +
        "schedule only when the user asks for a recurring run.",
      inputSchema: z.object({
        projectId: projectIdField,
        name: z.string().min(1).max(128),
        commands: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('dbt commands, e.g. ["build --select tag:nightly"]'),
        environment: z
          .string()
          .optional()
          .describe("Environment name; defaults to the project default"),
        schedule: z
          .object({ cron: z.string().min(1), timezone: z.string().min(1) })
          .optional()
          .describe("Optional cron schedule, e.g. { cron: '0 6 * * *' }"),
        enabled: z.boolean().default(true),
        deferToProduction: z.boolean().default(false),
      }),
      execute: async ({
        projectId,
        name,
        commands,
        environment,
        schedule,
        enabled,
        deferToProduction,
      }) => {
        try {
          const project = await assertProject(projectId);
          const env = environment ?? project.defaultEnvironment;
          const validationError = validateJob(project, {
            environment: env,
            commands,
            schedule,
          });
          if (validationError) {
            return { success: false, error: validationError };
          }
          const job = await DbtJob.create({
            workspaceId: project.workspaceId,
            projectId: project._id,
            name,
            environment: env,
            commands,
            schedule: schedule ?? undefined,
            enabled,
            deferToProduction,
            createdBy: "agent",
          });
          await applyJobScheduleChange(job);
          return {
            success: true,
            jobId: job._id.toString(),
            name: job.name,
            environment: job.environment,
            commands: job.commands,
            schedule: job.schedule,
            enabled: job.enabled,
          };
        } catch (error) {
          return toolError(error, "Failed to create dbt job");
        }
      },
    }),

    dbt_update_job: tool({
      description:
        "Update a saved dbt job's name, environment, commands, schedule, " +
        "enabled flag, or Slim-CI defer. Only the provided fields change. " +
        "Pass schedule: null to remove a schedule.",
      inputSchema: z.object({
        projectId: projectIdField,
        jobId: z.string().describe("dbt job ID (from read_dbt_project_tree)"),
        name: z.string().min(1).max(128).optional(),
        commands: z.array(z.string().min(1)).min(1).max(10).optional(),
        environment: z.string().optional(),
        schedule: z
          .object({ cron: z.string().min(1), timezone: z.string().min(1) })
          .nullable()
          .optional()
          .describe("Cron schedule; pass null to remove scheduling"),
        enabled: z.boolean().optional(),
        deferToProduction: z.boolean().optional(),
      }),
      execute: async ({ projectId, jobId, ...updates }) => {
        try {
          const project = await assertProject(projectId);
          if (!Types.ObjectId.isValid(jobId)) {
            return { success: false, error: "Invalid job id" };
          }
          const job = await DbtJob.findOne({
            _id: new Types.ObjectId(jobId),
            projectId: project._id,
          });
          if (!job) return { success: false, error: "Job not found" };

          const merged = {
            environment: updates.environment ?? job.environment,
            commands: updates.commands ?? job.commands,
            schedule:
              updates.schedule === undefined
                ? (job.schedule ?? null)
                : updates.schedule,
          };
          const validationError = validateJob(project, merged);
          if (validationError) {
            return { success: false, error: validationError };
          }

          if (updates.name !== undefined) job.name = updates.name;
          job.environment = merged.environment;
          job.commands = merged.commands;
          job.schedule = merged.schedule ?? undefined;
          if (updates.enabled !== undefined) job.enabled = updates.enabled;
          if (updates.deferToProduction !== undefined) {
            job.deferToProduction = updates.deferToProduction;
          }
          await job.save();
          await applyJobScheduleChange(job);
          return {
            success: true,
            jobId: job._id.toString(),
            name: job.name,
            environment: job.environment,
            commands: job.commands,
            schedule: job.schedule,
            enabled: job.enabled,
          };
        } catch (error) {
          return toolError(error, "Failed to update dbt job");
        }
      },
    }),
  };
};
