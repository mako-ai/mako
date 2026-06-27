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
  createDbtFileSchema,
  modifyDbtFileSchema,
  deleteDbtFileSchema,
} from "@mako/agent-tools";
import {
  DatabaseConnection,
  DbtFile,
  DbtJob,
  DbtProject,
  DbtRun,
} from "../../database/workspace-schema";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  createVersion,
  getLatestVersionNumber,
  getUserDisplayName,
} from "../../services/entity-version.service";
import { runAdhocDbtCommand } from "../../dbt/dbt-project.service";
import {
  applyJobScheduleChange,
  reconcileStaleQueuedRun,
  triggerDbtJobRun,
  triggerDbtRun,
} from "../../dbt/dbt-run.service";
import {
  DbtCommandValidationError,
  parseDbtCommands,
} from "../../dbt/commands";
import {
  commitAndPush,
  commitToNewBranch,
  createProjectBranch,
  deleteProjectBranch,
  getGitStatus,
  listProjectBranches,
  listRecoverableFiles,
  openProjectPullRequest,
  restoreDeletedFile,
  switchProjectBranch,
} from "../../dbt/dbt-github-git.service";
import { syncProjectFromRepo } from "../../dbt/dbt-github-sync.service";
import { generateDbtCommitMessage } from "../../dbt/dbt-commit-message.service";
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

/** Upper bound on dbt_get_run's server-side wait, well under proxy timeouts. */
const MAX_RUN_WAIT_MS = 90_000;
/** Cadence for the dbt_get_run wait loop — mirrors the IDE run-detail poll. */
const RUN_POLL_INTERVAL_MS = 2_000;

/** Sleep that resolves early when the turn is aborted (chat Stop). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

/** Mirror of dbt.routes.ts isSafeDbtPath — block traversal / absolute paths. */
function isSafeDbtPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length < 1024 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\")
  );
}

export const createDbtServerTools = (
  workspaceId: string,
  userId?: string,
  options?: { chatId?: string },
) => {
  const agentClientId = `agent:${options?.chatId ?? "unknown"}`;

  // Poke open dbt-file tabs to pull the new content (poke-then-pull, mirrors
  // the console #475 realtime sync).
  const publishFileUpdated = (
    projectId: string,
    path: string,
    deleted?: boolean,
  ) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.file.updated",
      projectId,
      path,
      deleted,
      updatedBy: userId ?? "agent",
      clientId: agentClientId,
      origin: "agent",
    });
  };

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

  /** Like assertProject, but also requires a connected Git repository. */
  const assertRepoProject = async (projectId: string) => {
    const project = await assertProject(projectId);
    if (!project.repo) {
      throw new Error(
        "This dbt project is not connected to a Git repository. Connect a " +
          "repo in project settings before using git tools.",
      );
    }
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

  // Snapshot a dbt file version (entity-version pattern, mirrors the route).
  const snapshotVersion = async (
    fileId: Types.ObjectId,
    wsId: Types.ObjectId,
    path: string,
    content: string,
  ) => {
    try {
      const latest = await getLatestVersionNumber(fileId, "dbt-file");
      const savedBy = userId ?? "agent";
      await createVersion({
        entityType: "dbt-file",
        entityId: fileId,
        workspaceId: wsId,
        snapshot: { path, content },
        savedBy,
        savedByName: userId ? await getUserDisplayName(userId) : "Agent",
        comment: `Save ${path} (v${latest + 1})`,
      });
    } catch {
      /* version history is best-effort */
    }
  };

  return {
    create_dbt_file: tool({
      description:
        "Create a new file in a dbt project (e.g. a staging model + its " +
        "schema.yml entry). Fails if the file already exists — use " +
        "modify_dbt_file to change existing files. After writing models, " +
        "verify with dbt_parse and dbt_compile_model.",
      inputSchema: createDbtFileSchema,
      execute: async ({ projectId, path, contents }) => {
        try {
          const project = await assertProject(projectId);
          if (!isSafeDbtPath(path)) {
            return { success: false, error: "Invalid file path" };
          }
          const existing = await DbtFile.findOne({
            projectId: project._id,
            path,
            is_deleted: { $ne: true },
          });
          if (existing) {
            return {
              success: false,
              error: `File already exists: ${path}. Use modify_dbt_file to change it.`,
            };
          }
          const file = await DbtFile.findOneAndUpdate(
            { projectId: project._id, path },
            {
              $set: {
                content: contents ?? "",
                updatedBy: userId,
                is_deleted: false,
                workspaceId: project.workspaceId,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          await snapshotVersion(
            file._id,
            project.workspaceId,
            path,
            contents ?? "",
          );
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path);
          return { success: true, path };
        } catch (error) {
          return toolError(error, "Failed to create dbt file");
        }
      },
    }),

    modify_dbt_file: tool({
      description:
        "Overwrite an existing dbt project file with full contents. The open " +
        "editor tab updates live; every save snapshots a version for undo. " +
        "After editing, verify with dbt_parse / dbt_compile_model.",
      inputSchema: modifyDbtFileSchema,
      execute: async ({ projectId, path, contents }) => {
        try {
          const project = await assertProject(projectId);
          if (!isSafeDbtPath(path)) {
            return { success: false, error: "Invalid file path" };
          }
          if ((contents ?? "").length > 1_000_000) {
            return { success: false, error: "File too large (max 1MB)" };
          }
          const file = await DbtFile.findOneAndUpdate(
            { projectId: project._id, path },
            {
              $set: {
                content: contents ?? "",
                updatedBy: userId,
                is_deleted: false,
                workspaceId: project.workspaceId,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          await snapshotVersion(
            file._id,
            project.workspaceId,
            path,
            contents ?? "",
          );
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path);
          return { success: true, path };
        } catch (error) {
          return toolError(error, "Failed to save dbt file");
        }
      },
    }),

    delete_dbt_file: tool({
      description: "Delete a file from a dbt project.",
      inputSchema: deleteDbtFileSchema,
      execute: async ({ projectId, path }) => {
        try {
          const project = await assertProject(projectId);
          const result = await DbtFile.updateOne(
            { projectId: project._id, path },
            { $set: { is_deleted: true, updatedBy: userId } },
          );
          if (result.matchedCount === 0) {
            return { success: false, error: `File not found: ${path}` };
          }
          publishFileUpdated(projectId, path, true);
          return { success: true, path };
        } catch (error) {
          return toolError(error, "Failed to delete dbt file");
        }
      },
    }),

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
        "(stg_orders+, +marts.orders, tag:nightly, state:modified+). " +
        "Runs ASYNCHRONOUSLY in the runner and returns a `runId` immediately " +
        "(it does NOT block until the build finishes). Poll `dbt_get_run` " +
        "with that `runId` (pass `waitMs`) to get per-node status, timing, " +
        "rows affected, and test pass/fail outcomes. Use this as the final " +
        "verification after compile succeeds.",
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
          const project = await assertProject(projectId);
          // Dispatch to the async runner instead of blocking the chat turn for
          // the full build. The build executes in the Inngest worker
          // (decoupled from this SSE connection), so it survives proxy idle
          // timeouts and API restarts. The agent verifies the outcome by
          // polling dbt_get_run; the chat renders a live run card from runId.
          const run = await triggerDbtRun({
            workspaceId,
            projectId,
            environment: environment ?? project.defaultEnvironment,
            commands: [`build --select ${model}`],
            trigger: "agent",
            triggeredBy: "agent",
          });
          return {
            success: true,
            runId: run._id.toString(),
            status: run.status,
            environment: run.environment,
            commands: run.commands,
            message:
              "Build started in the runner. Poll dbt_get_run with this runId " +
              "(pass waitMs) until status is success/error. The user sees " +
              "live progress in the run card.",
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
        "AFTER dbt_run_model or dbt_run_job to see whether the run passed or " +
        "failed (those only queue it). Pass `runId` for a specific run, or " +
        "`jobId` to get that job's most recent run. Pass `waitMs` to block " +
        "server-side until the run reaches a terminal status (success/error/" +
        "cancelled) or the wait elapses — call it ONCE with waitMs ~90000 " +
        "after dbt_run_model; if it returns still running, tell the user the " +
        "build is in progress and stop (the run card shows live progress).",
      inputSchema: z.object({
        projectId: projectIdField,
        runId: z
          .string()
          .optional()
          .describe("dbt run ID (from dbt_run_model / dbt_run_job)"),
        jobId: z
          .string()
          .optional()
          .describe("dbt job ID — returns the latest run for this job"),
        waitMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "If set, wait up to this many ms (capped at 90000) for the run " +
              "to finish before returning. Use ~90000 once after dbt_run_model.",
          ),
      }),
      execute: async ({ projectId, runId, jobId, waitMs }, { abortSignal }) => {
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

          const isTerminal = (status: string) =>
            status === "success" ||
            status === "error" ||
            status === "cancelled";

          const deadline = Date.now() + Math.min(waitMs ?? 0, MAX_RUN_WAIT_MS);

          let found = await DbtRun.findOne(query)
            .sort({ createdAt: -1 })
            .lean();
          if (!found) return { success: false, error: "Run not found" };
          // A run stuck in "queued" past the watchdog deadline is finalized as
          // an error here, so a never-picked-up run terminates the wait loop
          // instead of spinning to the full budget.
          let run = await reconcileStaleQueuedRun(found);

          // Bounded server-side wait: re-read until terminal, the budget
          // elapses, or the turn is aborted. Keepalives keep the SSE warm.
          while (
            !isTerminal(run.status) &&
            Date.now() + RUN_POLL_INTERVAL_MS <= deadline &&
            !abortSignal?.aborted
          ) {
            await sleep(RUN_POLL_INTERVAL_MS, abortSignal);
            found = await DbtRun.findOne(query).sort({ createdAt: -1 }).lean();
            if (!found) return { success: false, error: "Run not found" };
            run = await reconcileStaleQueuedRun(found);
          }

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

    dbt_sync_from_repo: tool({
      description:
        "Re-pull the latest commits from the project's tracked branch into the " +
        "working tree (Mongo), the same as the IDE 'Sync/Pull' action. Use this " +
        "when the project is building from a stale checkout — e.g. files were " +
        "merged on the remote (a PR landed on main) but the project hasn't " +
        "picked them up, so a run finds fewer models/sources than the branch " +
        "actually has. SAFE BY DEFAULT: files you've edited locally but not yet " +
        "committed are preserved (reported in `preservedLocal`), never " +
        "overwritten — only non-conflicting files fast-forward to the remote. " +
        "Pass discardLocalChanges:true to make the remote win and overwrite " +
        "local edits (only after the user confirms). To pull a DIFFERENT " +
        "branch, use dbt_switch_branch instead.",
      inputSchema: z.object({
        projectId: projectIdField,
        discardLocalChanges: z
          .boolean()
          .optional()
          .describe(
            "Set true to let the remote overwrite uncommitted local edits. " +
              "Default false keeps local edits and only fast-forwards the rest.",
          ),
      }),
      execute: async ({ projectId, discardLocalChanges }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await syncProjectFromRepo(project, userId ?? "agent", {
            preserveLocalEdits: !(discardLocalChanges ?? false),
          });
          return {
            success: true,
            branch: project.repo?.branch,
            sha: result.sha,
            added: result.added,
            updated: result.updated,
            deleted: result.deleted,
            skippedLarge: result.skippedLarge,
            preservedLocal: result.preservedLocal,
          };
        } catch (error) {
          return toolError(error, "Failed to sync from repo");
        }
      },
    }),

    dbt_list_recoverable_files: tool({
      description:
        "List soft-deleted dbt files whose content is still retained and can be " +
        "restored. Use this to RECOVER work that disappeared — e.g. models that " +
        "vanished after a branch switch/sync before the non-destructive guards " +
        "existed. These files are not in the normal project tree. Returns each " +
        "path with its retained content and when it was last edited; restore " +
        "the ones you want with dbt_restore_file.",
      inputSchema: z.object({ projectId: projectIdField }),
      execute: async ({ projectId }) => {
        try {
          const project = await assertRepoProject(projectId);
          const files = await listRecoverableFiles(project);
          return {
            success: true,
            count: files.length,
            files: files.map(f => ({
              path: f.path,
              updatedAt: f.updatedAt,
              updatedBy: f.updatedBy,
              contentPreview: f.content.slice(0, 2000),
              truncated: f.content.length > 2000,
            })),
          };
        } catch (error) {
          return toolError(error, "Failed to list recoverable files");
        }
      },
    }),

    dbt_restore_file: tool({
      description:
        "Restore a soft-deleted dbt file (from dbt_list_recoverable_files) back " +
        "into the working tree. It returns as a pending 'added' change you can " +
        "review with dbt_git_status and then commit. Use to recover work lost " +
        "to a destructive branch switch/sync.",
      inputSchema: z.object({
        projectId: projectIdField,
        path: z
          .string()
          .min(1)
          .describe("Project-relative path, e.g. models/staging/stg_x.sql"),
      }),
      execute: async ({ projectId, path }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await restoreDeletedFile(
            project,
            path.trim(),
            userId ?? "agent",
          );
          return { success: true, path: result.path };
        } catch (error) {
          return toolError(error, "Failed to restore file");
        }
      },
    }),

    dbt_git_status: tool({
      description:
        "Show the working-tree git status of a repo-bound dbt project: which " +
        "files are added/modified/deleted relative to the tracked branch, " +
        "and the branch name. Call this before dbt_commit_and_push to confirm " +
        "what will be committed, and to summarize pending changes for the user.",
      inputSchema: z.object({ projectId: projectIdField }),
      execute: async ({ projectId }) => {
        try {
          const project = await assertRepoProject(projectId);
          const status = await getGitStatus(project);
          return {
            success: true,
            branch: status.branch,
            hasChanges: status.hasChanges,
            added: status.added,
            modified: status.modified,
            deleted: status.deleted,
            changes: status.changes,
          };
        } catch (error) {
          return toolError(error, "Failed to read git status");
        }
      },
    }),

    dbt_commit_and_push: tool({
      description:
        "Commit ALL working-tree changes and push them to the project's " +
        "currently tracked branch in a single commit — the same action as the " +
        "IDE 'Commit & push' button. ONLY call this after the user has " +
        "explicitly asked you to commit/push (or clearly confirmed it in the " +
        "conversation); never commit proactively. If you omit `message`, a " +
        "Conventional Commits message is generated automatically from the " +
        "diff. Returns the new commit sha and per-type counts. To put changes " +
        "on a separate branch, call dbt_create_branch first, or use " +
        "dbt_open_pull_request when the user wants a review.",
      inputSchema: z.object({
        projectId: projectIdField,
        message: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Commit message. Omit to auto-generate one from the diff."),
      }),
      execute: async ({ projectId, message }) => {
        try {
          const project = await assertRepoProject(projectId);
          const status = await getGitStatus(project);
          if (!status.hasChanges) {
            return {
              success: false,
              error: "No changes to commit",
              branch: status.branch,
            };
          }

          let commitMessage = message?.trim();
          let generated = false;
          if (!commitMessage) {
            const ai = await generateDbtCommitMessage(project, {
              workspaceId,
              userId: userId ?? "agent",
            });
            if (ai) {
              commitMessage = ai;
              generated = true;
            }
          }
          if (!commitMessage) {
            return {
              success: false,
              error:
                "Could not generate a commit message — provide `message` " +
                "explicitly and retry.",
            };
          }

          const result = await commitAndPush(project, {
            message: commitMessage,
            updatedBy: userId ?? "agent",
          });
          return {
            success: result.committed,
            sha: result.sha,
            branch: result.branch,
            message: commitMessage,
            messageGenerated: generated,
            pushed: result.pushed,
          };
        } catch (error) {
          return toolError(error, "Failed to commit and push");
        }
      },
    }),

    dbt_commit_to_branch: tool({
      description:
        "ATOMIC PROMOTE: create a new feature branch off the current branch and " +
        "commit ALL working-tree changes onto it in a single, race-free step. " +
        "PREFER THIS over dbt_create_branch + dbt_commit_and_push when the user " +
        "wants their changes on a new branch for review: those two separate " +
        "calls can race a concurrent commit and leave the changes on the wrong " +
        "branch (e.g. main) with an empty feature branch. This tool does branch+" +
        "commit under one lock so that cannot happen. Afterwards the project " +
        "tracks the new branch with a clean tree — call dbt_open_pull_request " +
        "to raise the PR. ONLY call after the user has asked you to commit/push.",
      inputSchema: z.object({
        projectId: projectIdField,
        name: z
          .string()
          .min(1)
          .max(255)
          .describe("New branch name, e.g. 'feat/crm-conversation-mart'"),
        message: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Commit message. Omit to auto-generate one from the diff."),
      }),
      execute: async ({ projectId, name, message }) => {
        try {
          const project = await assertRepoProject(projectId);
          let commitMessage = message?.trim();
          let generated = false;
          if (!commitMessage) {
            const ai = await generateDbtCommitMessage(project, {
              workspaceId,
              userId: userId ?? "agent",
            });
            if (ai) {
              commitMessage = ai;
              generated = true;
            }
          }
          if (!commitMessage) {
            return {
              success: false,
              error:
                "Could not generate a commit message — provide `message` " +
                "explicitly and retry.",
            };
          }
          const result = await commitToNewBranch(project, {
            branchName: name.trim(),
            message: commitMessage,
            updatedBy: userId ?? "agent",
          });
          return {
            success: result.committed,
            sha: result.sha,
            branch: result.branch,
            fromBranch: result.fromBranch,
            message: commitMessage,
            messageGenerated: generated,
            pushed: result.pushed,
          };
        } catch (error) {
          return toolError(error, "Failed to commit to new branch");
        }
      },
    }),

    dbt_create_branch: tool({
      description:
        "Create a new branch off the project's current branch head and check " +
        "it out (track it). NOTE: to put pending working-tree changes on a new " +
        "branch, prefer dbt_commit_to_branch (atomic) — calling this then " +
        "dbt_commit_and_push separately can race a concurrent commit. Use this " +
        "only to branch with no pending changes. Branch content is " +
        "identical to the current branch — no re-sync needed.",
      inputSchema: z.object({
        projectId: projectIdField,
        name: z
          .string()
          .min(1)
          .max(255)
          .describe("New branch name, e.g. 'feat/add-orders-staging'"),
      }),
      execute: async ({ projectId, name }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await createProjectBranch(project, name.trim());
          return { success: true, branch: result.branch };
        } catch (error) {
          return toolError(error, "Failed to create branch");
        }
      },
    }),

    dbt_switch_branch: tool({
      description:
        "Switch the project's tracked branch and pull its contents into the " +
        "working tree. This OVERWRITES the working tree with the target branch. " +
        "For safety it REFUSES if there are uncommitted changes (so a branch " +
        "move can't silently destroy un-pushed work) — commit them first " +
        "(dbt_commit_and_push or dbt_commit_to_branch), or pass " +
        "discardLocalChanges:true to abandon them on purpose. Always run " +
        "dbt_git_status before switching.",
      inputSchema: z.object({
        projectId: projectIdField,
        branch: z.string().min(1).max(255).describe("Existing branch to track"),
        discardLocalChanges: z
          .boolean()
          .optional()
          .describe(
            "Set true to throw away uncommitted working-tree changes and force " +
              "the switch. Only after the user explicitly confirms discarding.",
          ),
      }),
      execute: async ({ projectId, branch, discardLocalChanges }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await switchProjectBranch(
            project,
            branch.trim(),
            userId ?? "agent",
            { discardLocalChanges: discardLocalChanges ?? false },
          );
          return {
            success: true,
            branch: result.branch,
            discardedChanges: result.discarded?.changes,
          };
        } catch (error) {
          return toolError(error, "Failed to switch branch");
        }
      },
    }),

    dbt_list_branches: tool({
      description:
        "List the remote branches of the project's connected repository, plus " +
        "the currently tracked branch. Use to pick a branch for " +
        "dbt_switch_branch or a base for dbt_open_pull_request.",
      inputSchema: z.object({ projectId: projectIdField }),
      execute: async ({ projectId }) => {
        try {
          const project = await assertRepoProject(projectId);
          const branches = await listProjectBranches(project);
          return {
            success: true,
            branches,
            current: project.repo?.branch,
          };
        } catch (error) {
          return toolError(error, "Failed to list branches");
        }
      },
    }),

    dbt_delete_branch: tool({
      description:
        "Delete a remote branch from the project's repository — use to clean up " +
        "a stray/merged feature branch (e.g. after its PR is merged, or an " +
        "abandoned branch from a failed promote). Refuses to delete the branch " +
        "the project currently tracks (switch away first with dbt_switch_branch) " +
        "and the repo's default branch. Idempotent: deleting an already-gone " +
        "branch succeeds. ONLY call after the user confirms the branch name.",
      inputSchema: z.object({
        projectId: projectIdField,
        name: z.string().min(1).max(255).describe("Branch to delete"),
      }),
      execute: async ({ projectId, name }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await deleteProjectBranch(project, name.trim());
          return { success: true, deleted: result.deleted };
        } catch (error) {
          return toolError(error, "Failed to delete branch");
        }
      },
    }),

    dbt_open_pull_request: tool({
      description:
        "Open a GitHub pull request from the project's current branch into a " +
        "base branch (defaults to the repo's default branch). Use this when " +
        "the user wants their changes reviewed rather than pushed straight to " +
        "the main branch. The current branch must differ from the base — " +
        "create a feature branch with dbt_create_branch and commit to it " +
        "first. Returns the PR number and URL.",
      inputSchema: z.object({
        projectId: projectIdField,
        title: z.string().min(1).max(255).describe("Pull request title"),
        body: z
          .string()
          .max(10_000)
          .optional()
          .describe("Pull request description (Markdown)"),
        base: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Base branch to merge into; defaults to the repo default"),
      }),
      execute: async ({ projectId, title, body, base }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await openProjectPullRequest(project, {
            title: title.trim(),
            body,
            base,
          });
          return {
            success: true,
            number: result.number,
            url: result.htmlUrl,
          };
        } catch (error) {
          return toolError(error, "Failed to open pull request");
        }
      },
    }),
  };
};
