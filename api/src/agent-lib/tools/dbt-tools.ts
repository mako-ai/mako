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
  editDbtFileSchema,
  deleteDbtFileSchema,
  readDbtTreeSchema,
  readDbtFileSchema,
  applyStrReplace,
  buildStrReplaceDiff,
} from "@mako/agent-tools";
import {
  DatabaseConnection,
  DbtJob,
  DbtProject,
  DbtRun,
} from "../../database/workspace-schema";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { workspaceService } from "../../services/workspace.service";
import {
  ensurePersonalDbtEnvironment,
  findPersonalEnvironment,
  getUserDevEnvPreference,
  resolveDevEnvironmentForUser,
  resolveProdLikeEnvironmentName,
} from "../../dbt/dbt-environments.service";
import {
  applyJobScheduleChange,
  reconcileStaleQueuedRun,
  requestDbtRunCancel,
  triggerDbtJobRun,
  triggerDbtRun,
} from "../../dbt/dbt-run.service";
import {
  DbtCommandValidationError,
  parseDbtCommands,
} from "../../dbt/commands";
import {
  commitDbtFiles,
  deleteWorkingFile,
  getCheckoutBranch,
  listWorkingFiles,
  readWorkingFile,
  writeWorkingFile,
} from "../../dbt/dbt-working-tree.service";
import { resolveDbtRules } from "../../dbt/dbt-rules.service";
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
  // Drafts/checkouts belong to the user the agent acts for; without a user
  // session (rare) the agent gets its own overlay under the "agent" owner.
  const actingUserId = userId ?? "agent";

  // Poke open dbt-file tabs to pull the new content (poke-then-pull, mirrors
  // the console #475 realtime sync). Draft edits carry forUserId so only the
  // acting user's windows react.
  const publishFileUpdated = (
    projectId: string,
    path: string,
    opts?: { deleted?: boolean; draft?: boolean },
  ) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.file.updated",
      projectId,
      path,
      deleted: opts?.deleted,
      updatedBy: actingUserId,
      clientId: agentClientId,
      origin: "agent",
      forUserId: opts?.draft ? actingUserId : undefined,
    });
  };

  const publishJobUpdated = (projectId: string) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.job.updated",
      projectId,
      clientId: agentClientId,
    });
  };

  const publishRunUpdated = (
    projectId: string,
    ids?: { runId?: string; jobId?: string },
  ) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.run.updated",
      projectId,
      runId: ids?.runId,
      jobId: ids?.jobId,
      clientId: agentClientId,
    });
  };

  const publishProjectUpdated = (projectId?: string) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.project.updated",
      projectId,
      clientId: agentClientId,
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

  type EnvProject = Parameters<typeof resolveDevEnvironmentForUser>[0] & {
    lastProdManifestKey?: string;
  };

  /**
   * Environment an ad-hoc action targets when the agent passed none:
   * explicit > the acting user's saved per-user dev environment > their
   * personal environment when provisioned > the project default. Single
   * player: dev IS the personal target; teams: per-user envs/choices keep
   * builds out of teammates' schemas.
   */
  const resolveEnvironment = (
    project: EnvProject,
    requested?: string,
  ): Promise<string> =>
    resolveDevEnvironmentForUser(project, actingUserId, requested);

  /**
   * Default defer decision for ad-hoc builds/previews: defer to the last prod
   * manifest when iterating OUTSIDE the prod-like environment and a prod
   * build exists — so one model can be rebuilt in a personal schema without
   * first rebuilding its whole upstream DAG there.
   */
  const shouldDeferByDefault = (
    project: EnvProject,
    environmentName: string,
  ): boolean =>
    Boolean(project.lastProdManifestKey) &&
    environmentName !== resolveProdLikeEnvironmentName(project);

  const queueAgentRun = async (
    project: Awaited<ReturnType<typeof assertProject>>,
    environment: string,
    commands: string[],
    deferToProduction = false,
  ) => {
    const run = await triggerDbtRun({
      workspaceId,
      projectId: project._id.toString(),
      environment,
      commands,
      trigger: "agent",
      triggeredBy: "agent",
      workingTreeUserId: actingUserId,
      deferToProduction,
    });
    publishRunUpdated(project._id.toString(), {
      runId: run._id.toString(),
    });
    return {
      success: true as const,
      runId: run._id.toString(),
      status: run.status,
      environment: run.environment,
      commands: run.commands,
    };
  };

  const deferField = z
    .boolean()
    .optional()
    .describe(
      "Run with --defer --state <last prod manifest> so unselected refs " +
        "resolve to the production build (fast iteration: no need to " +
        "rebuild upstream models in your schema). Defaults to true when " +
        "targeting a non-prod environment and a prod manifest exists.",
    );

  return {
    read_dbt_project_tree: tool({
      description:
        "List dbt projects in the workspace, or the file tree + jobs of one " +
        "project when projectId is given. Call this FIRST to get project IDs " +
        "and file paths before using any other dbt tool. When the project has " +
        "a .makorules file, its contents come back in `rules` — those are " +
        "binding conventions for any SQL you write in that project.",
      inputSchema: readDbtTreeSchema,
      execute: async ({ projectId }) => {
        try {
          if (!projectId) {
            const projects = await DbtProject.find({
              workspaceId: new Types.ObjectId(workspaceId),
            })
              .sort({ updatedAt: -1 })
              .lean();
            return {
              success: true as const,
              projects: projects.map(p => ({
                id: p._id.toString(),
                name: p.name,
                defaultEnvironment: p.defaultEnvironment,
                environments: (p.environments ?? []).map(env => ({
                  name: env.name,
                  targetSchema: env.targetSchema,
                  connectionId: env.connectionId?.toString(),
                  ...(env.ownerUserId
                    ? { personal: true, ownerUserId: env.ownerUserId }
                    : {}),
                })),
              })),
            };
          }
          const project = await assertProject(projectId);
          const [files, jobs, rules] = await Promise.all([
            listWorkingFiles(project, actingUserId),
            DbtJob.find({ projectId: project._id }).lean(),
            resolveDbtRules(project, actingUserId),
          ]);
          return {
            success: true as const,
            projectId,
            name: project.name,
            defaultEnvironment: project.defaultEnvironment,
            environments: project.environments,
            files: files.map(f => f.path),
            // Team-authored rules for this project — binding for any SQL
            // written here. Omitted entirely when the project has none.
            // `truncated` is only included (as `true`) when the file was
            // cut at DBT_RULES_MAX_CHARS, so a model reasoning off this tool
            // result alone (without the prompt block) still knows it isn't
            // looking at the whole file.
            ...(rules
              ? {
                  rules: {
                    path: rules.path,
                    contents: rules.contents,
                    ...(rules.truncated ? { truncated: true } : {}),
                  },
                }
              : {}),
            jobs: jobs.map(job => ({
              id: job._id.toString(),
              name: job.name,
              environment: job.environment,
              commands: job.commands,
              schedule: job.schedule ?? null,
              enabled: job.enabled,
            })),
          };
        } catch (error) {
          return toolError(error, "Failed to read dbt project tree");
        }
      },
    }),

    read_dbt_file: tool({
      description:
        "Read the full contents of a single file in a dbt project " +
        "(models, schema.yml, dbt_project.yml, seeds, macros...).",
      inputSchema: readDbtFileSchema,
      execute: async ({ projectId, path }) => {
        try {
          const project = await assertProject(projectId);
          const file = await readWorkingFile(project, actingUserId, path);
          if (!file) {
            return {
              success: false as const,
              error: `File not found: ${path}`,
            };
          }
          return {
            success: true as const,
            path: file.path,
            contents: file.content,
          };
        } catch (error) {
          return toolError(error, "Failed to read dbt file");
        }
      },
    }),

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
          const existing = await readWorkingFile(project, actingUserId, path);
          if (existing) {
            return {
              success: false,
              error: `File already exists: ${path}. Use modify_dbt_file to change it.`,
            };
          }
          await writeWorkingFile(project, actingUserId, path, contents ?? "");
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
        "Fully rewrite an existing dbt project file with complete contents. " +
        "For modifying part of a file prefer edit_dbt_file (anchored old/new " +
        "string) — it avoids re-sending unchanged code. The open editor tab " +
        "updates live; every save snapshots a version for undo. After " +
        "editing, verify with dbt_parse / dbt_compile_model.",
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
          await writeWorkingFile(project, actingUserId, path, contents ?? "");
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

    edit_dbt_file: tool({
      description:
        "Edit an existing dbt project file by replacing an exact text " +
        "match. This is the PRIMARY tool for modifying dbt files: pass the " +
        "exact current text as oldString (unique — include surrounding " +
        'lines to disambiguate) and the replacement as newString ("" ' +
        "deletes it). Set replaceAll: true for renames. Use modify_dbt_file " +
        "only for full rewrites. After editing, verify with dbt_parse / " +
        "dbt_compile_model.",
      inputSchema: editDbtFileSchema,
      execute: async ({
        projectId,
        path,
        oldString,
        newString,
        replaceAll,
      }) => {
        try {
          const project = await assertProject(projectId);
          if (!isSafeDbtPath(path)) {
            return { success: false, error: "Invalid file path" };
          }
          // Read + write through the working-tree service (same as
          // modify_dbt_file): the edit is a commit on the caller's session
          // branch of the workspace repo.
          const file = await readWorkingFile(project, actingUserId, path);
          if (!file) {
            return {
              success: false,
              error: `File not found: ${path}. Use read_dbt_project_tree to list files, or create_dbt_file to create it.`,
            };
          }
          const current = file.content ?? "";
          const result = applyStrReplace(
            current,
            oldString,
            newString,
            replaceAll === true,
          );
          if (!result.ok) {
            return { success: false, error: result.error };
          }
          if (result.contents.length > 1_000_000) {
            return { success: false, error: "File too large (max 1MB)" };
          }
          const diff = buildStrReplaceDiff(
            current,
            oldString,
            newString,
            result.replacements,
          );
          await writeWorkingFile(project, actingUserId, path, result.contents);
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path);
          return {
            success: true,
            path,
            replacements: result.replacements,
            diff,
          };
        } catch (error) {
          return toolError(error, "Failed to edit dbt file");
        }
      },
    }),

    delete_dbt_file: tool({
      description: "Delete a file from a dbt project.",
      inputSchema: deleteDbtFileSchema,
      execute: async ({ projectId, path }) => {
        try {
          const project = await assertProject(projectId);
          const deleted = await deleteWorkingFile(project, actingUserId, path);
          if (!deleted) {
            return { success: false, error: `File not found: ${path}` };
          }
          publishFileUpdated(projectId, path, { deleted: true });
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
          await commitDbtFiles(
            project,
            actingUserId,
            Object.fromEntries(scaffold.map(f => [f.path, f.content])),
            `dbt: scaffold project "${name}"`,
          );

          publishProjectUpdated(project._id.toString());
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

    dbt_ensure_dev_environment: tool({
      description:
        "Idempotently provision the acting user's PERSONAL dbt environment " +
        "on a project (dbt Cloud-style development credentials): same " +
        "warehouse connection as prod, private schema `dbt_<user>`. Once it " +
        "exists, dbt_parse / dbt_compile_model / dbt_run_model / dbt_show " +
        "default to it automatically. Intended for MULTI-USER workspaces " +
        "(dbt_run_model auto-provisions it there on the first build); solo " +
        "workspaces normally keep building the shared dev environment — only " +
        "provision explicitly when the user asks for an isolated schema. " +
        "Safe to call repeatedly.",
      inputSchema: z.object({ projectId: projectIdField }),
      execute: async ({ projectId }) => {
        try {
          const project = await assertProject(projectId);
          if (!userId) {
            return {
              success: false,
              error:
                "Personal environments require a user session; pick an " +
                "explicit environment instead.",
            };
          }
          const existing = findPersonalEnvironment(project, userId);
          const result = existing
            ? { environment: existing, created: false }
            : await ensurePersonalDbtEnvironment({
                workspaceId,
                projectId,
                userId,
              });
          if (result.created) publishProjectUpdated(projectId);
          return {
            success: true,
            created: result.created,
            environment: result.environment.name,
            targetSchema: result.environment.targetSchema,
            message: result.created
              ? `Personal environment "${result.environment.name}" created ` +
                `(schema ${result.environment.targetSchema}). Ad-hoc dbt ` +
                "tools now default to it."
              : `Personal environment "${result.environment.name}" already ` +
                `exists (schema ${result.environment.targetSchema}).`,
          };
        } catch (error) {
          return toolError(error, "Failed to ensure personal environment");
        }
      },
    }),

    dbt_parse: tool({
      description:
        "Validate the entire dbt project (dbt parse): catches Jinja errors, " +
        "bad refs/sources, and schema.yml problems WITHOUT touching the " +
        "warehouse. Queues an asynchronous run and returns runId immediately; " +
        "poll dbt_get_run for the result.",
      inputSchema: z.object({
        projectId: projectIdField,
        environment: z
          .string()
          .optional()
          .describe(
            "Environment name; defaults to your personal environment when " +
              "provisioned, else the project default",
          ),
      }),
      execute: async ({ projectId, environment }) => {
        try {
          const project = await assertProject(projectId);
          const environmentName = await resolveEnvironment(
            project,
            environment,
          );
          const result = await queueAgentRun(project, environmentName, [
            "parse",
          ]);
          return {
            ...result,
            message: "Parse queued. Poll dbt_get_run with runId.",
          };
        } catch (error) {
          return toolError(error, "Failed to run dbt parse");
        }
      },
    }),

    dbt_compile_model: tool({
      description:
        "Compile dbt nodes (dbt compile --select <selector>) and surface the " +
        "Jinja/compilation result through dbt_get_run. No " +
        "warehouse writes. `model` accepts a node name (stg_orders) or a dbt " +
        "selector with graph operators/methods (+stg_orders, tag:nightly, " +
        "path:models/staging). Queues an asynchronous run and returns runId.",
      inputSchema: z.object({
        projectId: projectIdField,
        model: z
          .string()
          .describe(
            "Node name (stg_orders) or dbt selector (+stg_orders, tag:nightly)",
          ),
        environment: z.string().optional(),
        defer: deferField,
      }),
      execute: async ({ projectId, model, environment, defer }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          const environmentName = await resolveEnvironment(
            project,
            environment,
          );
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          const result = await queueAgentRun(
            project,
            environmentName,
            [`compile --select ${model}`],
            wantsDefer,
          );
          return {
            ...result,
            defer: wantsDefer,
            message: "Compile queued. Poll dbt_get_run with runId.",
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
        "On repo-connected projects this builds YOUR working tree — your " +
        "checkout branch plus your uncommitted drafts — so it is the ONLY " +
        "run tool that verifies uncommitted or feature-branch work (jobs " +
        "always build the committed tracked branch instead). Pass " +
        "`fullRefresh: true` to rebuild incremental models from scratch. " +
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
            "Environment name. Omit it: builds default to the user's saved " +
              "dev environment, else their personal environment. Solo " +
              "workspaces default to the shared dev environment (dev IS the " +
              "personal target); multi-user workspaces auto-provision a " +
              "personal environment (schema dbt_<user>) on first build so " +
              "teammates never build over each other. The prod-like " +
              "environment refuses ad-hoc builds — deploys go through jobs.",
          ),
        fullRefresh: z
          .boolean()
          .optional()
          .describe(
            "Run with --full-refresh: drop and rebuild the selected " +
              "incremental models from scratch. Use after changing an " +
              "incremental model's schema or logic — do NOT trigger a " +
              "full-refresh JOB for this (jobs build the committed tracked " +
              "branch, not your working tree).",
          ),
        defer: deferField,
      }),
      execute: async ({
        projectId,
        model,
        environment,
        fullRefresh,
        defer,
      }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          let environmentName = await resolveEnvironment(project, environment);
          // Smart default, following the single/multi-player model:
          //  - SINGLE player (sole workspace member): the shared dev default
          //    IS their personal target — never invent a `dbt_<user>` schema.
          //  - MULTIPLE players: auto-provision the caller's PERSONAL
          //    environment on first build so teammates never build over each
          //    other's schemas.
          // An explicit `environment` or a saved per-user choice always wins;
          // best-effort — a provisioning failure falls back to the default.
          let autoProvisionedEnv: string | undefined;
          if (
            !environment &&
            userId &&
            project.environments.length > 0 &&
            !findPersonalEnvironment(project, userId) &&
            !(await getUserDevEnvPreference(project, userId))
          ) {
            try {
              const members = await workspaceService.getMembers(workspaceId);
              if (members.length > 1) {
                const ensured = await ensurePersonalDbtEnvironment({
                  workspaceId,
                  projectId,
                  userId,
                });
                environmentName = ensured.environment.name;
                if (ensured.created) {
                  autoProvisionedEnv = ensured.environment.targetSchema;
                  publishProjectUpdated(projectId);
                }
              }
            } catch {
              /* fall back to the resolved default environment */
            }
          }
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          // The source tree this run builds: the acting user's session
          // branch — surfaced in the result so the agent never has to guess
          // which git state was verified.
          const sourceBranch = await getCheckoutBranch(project, actingUserId);
          // Dispatch to the async runner instead of blocking the chat turn for
          // the full build. The build executes in the Inngest worker
          // (decoupled from this SSE connection), so it survives proxy idle
          // timeouts and API restarts. The agent verifies the outcome by
          // polling dbt_get_run; the chat renders a live run card from runId.
          const run = await triggerDbtRun({
            workspaceId,
            projectId,
            environment: environmentName,
            commands: [
              `build --select ${model}${fullRefresh ? " --full-refresh" : ""}`,
            ],
            trigger: "agent",
            triggeredBy: "agent",
            // Build the acting user's working tree (checkout + drafts) so
            // the run verifies exactly the uncommitted edits just made.
            workingTreeUserId: actingUserId,
            deferToProduction: wantsDefer,
          });
          publishRunUpdated(projectId, { runId: run._id.toString() });
          return {
            success: true,
            runId: run._id.toString(),
            status: run.status,
            environment: run.environment,
            defer: wantsDefer,
            commands: run.commands,
            ...(sourceBranch ? { sourceBranch } : {}),
            message:
              "Build started in the runner. Poll dbt_get_run with this runId " +
              "(pass waitMs) until status is success/error. The user sees " +
              "live progress in the run card." +
              (autoProvisionedEnv
                ? ` Provisioned your personal environment "${run.environment}" ` +
                  `(schema ${autoProvisionedEnv}) — ad-hoc builds now default ` +
                  "to it."
                : "") +
              (sourceBranch
                ? ` Building your working tree on "${sourceBranch}" ` +
                  "(committed base + your uncommitted drafts)."
                : "") +
              (wantsDefer
                ? " Running with --defer: unselected refs resolve to the " +
                  "last prod build."
                : ""),
          };
        } catch (error) {
          return toolError(error, "Failed to run model");
        }
      },
    }),

    dbt_run_job: tool({
      description:
        "Trigger a saved dbt job (full command list, possibly against prod). " +
        "Jobs ALWAYS build the project's tracked branch as COMMITTED to git " +
        "— NEVER your checkout branch or uncommitted drafts. Do not use a " +
        "job to verify draft or feature-branch work (it would silently run " +
        "the old code); use dbt_run_model (supports fullRefresh) instead. " +
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
          publishRunUpdated(projectId, {
            runId: run._id.toString(),
            jobId: job._id.toString(),
          });
          const trackedBranch = "main";
          return {
            success: true,
            runId: run._id.toString(),
            jobName: job.name,
            environment: job.environment,
            commands: job.commands,
            ...(trackedBranch ? { sourceBranch: trackedBranch } : {}),
            message:
              "Run queued. " +
              (trackedBranch
                ? `This job builds the COMMITTED "${trackedBranch}" branch — ` +
                  "your checkout and uncommitted drafts are NOT included. " +
                  "To verify working-tree changes use dbt_run_model instead. "
                : "") +
              "The user can watch live logs in the job tab " +
              "(Transforms → Jobs).",
          };
        } catch (error) {
          return toolError(error, "Failed to trigger job");
        }
      },
    }),

    dbt_cancel_run: tool({
      description:
        "Cancel a queued or running dbt run by runId. A queued run is " +
        "cancelled before it starts (freeing the queue); a running run has " +
        "its dbt subprocess terminated and any in-flight BigQuery jobs " +
        "best-effort cancelled. Idempotent: cancelling an already-finished " +
        "run is a no-op that returns its current status. Use after " +
        "dbt_run_model / dbt_run_job (with the returned runId) when the user " +
        "asks to stop a build.",
      inputSchema: z.object({
        projectId: projectIdField,
        runId: z
          .string()
          .describe("dbt run ID (from dbt_run_model / dbt_run_job)"),
      }),
      execute: async ({ projectId, runId }) => {
        try {
          await assertProject(projectId);
          if (!Types.ObjectId.isValid(runId)) {
            return { success: false, error: "Invalid run id" };
          }
          const result = await requestDbtRunCancel({
            workspaceId,
            runId,
            cancelledBy: userId ?? "agent",
          });
          if (!result) return { success: false, error: "Run not found" };
          publishRunUpdated(projectId, { runId });
          return {
            success: true,
            runId,
            status: result.status,
            cancelledAt: result.cancelledAt,
            cancelledBy: result.cancelledBy,
            message:
              result.status === "cancelled"
                ? "Run cancelled."
                : `Run is already ${result.status}; nothing to cancel.`,
          };
        } catch (error) {
          return toolError(error, "Failed to cancel run");
        }
      },
    }),

    dbt_get_run: tool({
      description:
        "Read the status, step results, and logs of a dbt run — use this " +
        "AFTER dbt_parse, dbt_compile_model, dbt_show, dbt_run_model, or " +
        "dbt_run_job to see whether the run passed or failed (those only " +
        "queue it). Pass `runId` for a specific run, or " +
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
            output: run.output,
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
        "that a transform produces the expected output. Queues an asynchronous " +
        "run; poll dbt_get_run for the preview logs.",
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
        defer: deferField,
      }),
      execute: async ({ projectId, model, limit, environment, defer }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          const environmentName = await resolveEnvironment(
            project,
            environment,
          );
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          const result = await queueAgentRun(
            project,
            environmentName,
            [`show --select ${model} --limit ${limit}`],
            wantsDefer,
          );
          return {
            ...result,
            defer: wantsDefer,
            message: "Preview queued. Poll dbt_get_run with runId.",
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
          publishJobUpdated(projectId);
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
          publishJobUpdated(projectId);
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

    dbt_delete_job: tool({
      description:
        "Permanently delete a saved dbt job. Call read_dbt_project_tree first " +
        "to confirm the job id and name. Only delete when the user explicitly " +
        "asks — this removes the job definition and stops its schedule; past " +
        "run history is kept.",
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
          const name = job.name;
          await DbtJob.deleteOne({ _id: job._id, projectId: project._id });
          publishJobUpdated(projectId);
          return { success: true, jobId: job._id.toString(), name };
        } catch (error) {
          return toolError(error, "Failed to delete dbt job");
        }
      },
    }),
  };
};
