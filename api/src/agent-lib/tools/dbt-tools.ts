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
  DbtFile,
  DbtJob,
  DbtProject,
  DbtRun,
} from "../../database/workspace-schema";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { workspaceService } from "../../services/workspace.service";
import {
  createVersion,
  getLatestVersionNumber,
  getUserDisplayName,
} from "../../services/entity-version.service";
import {
  loadDbtDeferState,
  runAdhocDbtCommand,
} from "../../dbt/dbt-project.service";
import {
  ensurePersonalDbtEnvironment,
  findPersonalEnvironment,
  resolveEnvironmentNameForUser,
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
  closeProjectPullRequest,
  commitAndPush,
  commitToNewBranch,
  createProjectBranch,
  deleteProjectBranch,
  getGitStatus,
  listProjectBranches,
  listProjectPullRequests,
  listRecoverableFiles,
  mergeProjectPullRequest,
  openProjectPullRequest,
  restoreDeletedFile,
  switchProjectBranch,
  updateProjectPullRequest,
} from "../../dbt/dbt-github-git.service";
import { syncProjectBranchFromRepo } from "../../dbt/dbt-github-sync.service";
import {
  deleteWorkingFile,
  discardUserDrafts,
  getCheckoutBranch,
  listWorkingFiles,
  readWorkingFile,
  writeWorkingFile,
} from "../../dbt/dbt-working-tree.service";
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

const dbtCommitPathsField = z
  .array(
    z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "Project-relative changed file path, e.g. models/staging/stg_orders.sql",
      ),
  )
  .min(1)
  .max(100)
  .optional()
  .describe(
    "Optional project-relative changed paths to commit. Omit to commit all " +
      "working-tree changes; pass this when dbt_git_status shows unrelated " +
      "pending files that should stay uncommitted.",
  );

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

  // Git surface changed (commit/sync/merge/restore): open windows refetch
  // git status + tree.
  const publishGitUpdated = (projectId: string, forUser?: boolean) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.git.updated",
      projectId,
      updatedBy: actingUserId,
      clientId: agentClientId,
      forUserId: forUser ? actingUserId : undefined,
    });
  };

  // The acting user's checkout moved (branch create/switch): their windows
  // refresh branch label, tree, and status.
  const publishCheckoutUpdated = (projectId: string, branch: string) => {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.checkout.updated",
      projectId,
      branch,
      forUserId: actingUserId,
      updatedBy: actingUserId,
      clientId: agentClientId,
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

  type EnvProject = Parameters<typeof resolveEnvironmentNameForUser>[0] & {
    lastProdManifestKey?: string;
  };

  /**
   * Environment an ad-hoc action targets when the agent passed none: the
   * acting user's personal environment when provisioned, else the project
   * default. Explicit names always win.
   */
  const resolveEnvironment = (
    project: EnvProject,
    requested?: string,
  ): string => resolveEnvironmentNameForUser(project, actingUserId, requested);

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

  const deferField = z
    .boolean()
    .optional()
    .describe(
      "Run with --defer --state <last prod manifest> so unselected refs " +
        "resolve to the production build (fast iteration: no need to " +
        "rebuild upstream models in your schema). Defaults to true when " +
        "targeting a non-prod environment and a prod manifest exists.",
    );

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
    read_dbt_project_tree: tool({
      description:
        "List dbt projects in the workspace, or the file tree + jobs of one " +
        "project when projectId is given. Call this FIRST to get project IDs " +
        "and file paths before using any other dbt tool.",
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
          const [files, jobs] = await Promise.all([
            listWorkingFiles(project, actingUserId),
            DbtJob.find({ projectId: project._id }).lean(),
          ]);
          return {
            success: true as const,
            projectId,
            name: project.name,
            defaultEnvironment: project.defaultEnvironment,
            environments: project.environments,
            files: files.map(f => f.path),
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
          const { versionEntityId } = await writeWorkingFile(
            project,
            actingUserId,
            path,
            contents ?? "",
          );
          await snapshotVersion(
            versionEntityId,
            project.workspaceId,
            path,
            contents ?? "",
          );
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path, {
            draft: Boolean(project.repo),
          });
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
          const { versionEntityId } = await writeWorkingFile(
            project,
            actingUserId,
            path,
            contents ?? "",
          );
          await snapshotVersion(
            versionEntityId,
            project.workspaceId,
            path,
            contents ?? "",
          );
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path, {
            draft: Boolean(project.repo),
          });
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
          // modify_dbt_file): repo projects edit the caller's DRAFT overlay
          // on their checkout branch — never the committed base tree — so
          // the edit shows up in dbt_git_status / the Version Control UI and
          // stays invisible to other users until committed.
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
          const { versionEntityId } = await writeWorkingFile(
            project,
            actingUserId,
            path,
            result.contents,
          );
          await snapshotVersion(
            versionEntityId,
            project.workspaceId,
            path,
            result.contents,
          );
          await DbtProject.updateOne(
            { _id: project._id },
            { $currentDate: { updatedAt: true } },
          );
          publishFileUpdated(projectId, path, {
            draft: Boolean(project.repo),
          });
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
          publishFileUpdated(projectId, path, {
            deleted: true,
            draft: Boolean(project.repo),
          });
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
        "default to it automatically, so iteration never writes to shared " +
        "dev/prod schemas. Call this before building models when the user " +
        "wants to iterate safely (or when read_dbt_project_tree shows no " +
        "personal environment). Safe to call repeatedly.",
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
        "warehouse. Run this after editing YAML or multiple files.",
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
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName: resolveEnvironment(project, environment),
            userId: actingUserId,
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
        defer: deferField,
      }),
      execute: async ({ projectId, model, environment, defer }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          const environmentName = resolveEnvironment(project, environment);
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName,
            userId: actingUserId,
            command: `compile --select ${model}`,
            select: model,
            deferState: wantsDefer
              ? await loadDbtDeferState(project)
              : undefined,
            timeoutMs: 3 * 60 * 1000,
          });
          return {
            success: result.success,
            environment: environmentName,
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
            "Environment name; defaults to your personal environment when " +
              "provisioned, else the project default (dev). Only use prod " +
              "when the user explicitly asks.",
          ),
        defer: deferField,
      }),
      execute: async ({ projectId, model, environment, defer }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          const environmentName = resolveEnvironment(project, environment);
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          // Dispatch to the async runner instead of blocking the chat turn for
          // the full build. The build executes in the Inngest worker
          // (decoupled from this SSE connection), so it survives proxy idle
          // timeouts and API restarts. The agent verifies the outcome by
          // polling dbt_get_run; the chat renders a live run card from runId.
          const run = await triggerDbtRun({
            workspaceId,
            projectId,
            environment: environmentName,
            commands: [`build --select ${model}`],
            trigger: "agent",
            triggeredBy: "agent",
            // Build the acting user's working tree (checkout + drafts) so
            // the run verifies exactly the uncommitted edits just made.
            workingTreeUserId: project.repo ? actingUserId : undefined,
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
            message:
              "Build started in the runner. Poll dbt_get_run with this runId " +
              "(pass waitMs) until status is success/error. The user sees " +
              "live progress in the run card." +
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
        defer: deferField,
      }),
      execute: async ({ projectId, model, limit, environment, defer }) => {
        try {
          if (!SELECTOR_PATTERN.test(model)) {
            return { success: false, error: "Invalid model selector" };
          }
          const project = await assertProject(projectId);
          const environmentName = resolveEnvironment(project, environment);
          const wantsDefer =
            defer ?? shouldDeferByDefault(project, environmentName);
          const result = await runAdhocDbtCommand({
            workspaceId,
            projectId,
            environmentName,
            userId: actingUserId,
            command: `show --select ${model} --limit ${limit}`,
            deferState: wantsDefer
              ? await loadDbtDeferState(project)
              : undefined,
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

    dbt_sync_from_repo: tool({
      description:
        "Re-pull the latest commits of the user's checked-out branch into its " +
        "committed base tree, the same as the IDE 'Sync/Pull' action. Use this " +
        "when the project is building from a stale checkout — e.g. files were " +
        "merged on the remote (a PR landed on main) but the project hasn't " +
        "picked them up. ALWAYS SAFE: uncommitted edits live in a per-user " +
        "draft overlay that a sync never touches. Pass discardLocalChanges:" +
        "true to ALSO drop the user's uncommitted drafts before pulling (a " +
        "`git checkout -- .`; only after the user confirms). To pull a " +
        "DIFFERENT branch, use dbt_switch_branch instead.",
      inputSchema: z.object({
        projectId: projectIdField,
        discardLocalChanges: z
          .boolean()
          .optional()
          .describe(
            "Set true to also discard the user's uncommitted draft edits. " +
              "Default false keeps drafts (they overlay the pulled tree).",
          ),
      }),
      execute: async ({ projectId, discardLocalChanges }) => {
        try {
          const project = await assertRepoProject(projectId);
          if (discardLocalChanges) {
            await discardUserDrafts(project, actingUserId);
          }
          const branch = (await getCheckoutBranch(
            project,
            actingUserId,
          )) as string;
          const result = await syncProjectBranchFromRepo(
            project,
            branch,
            actingUserId,
          );
          publishGitUpdated(projectId);
          return {
            success: true,
            branch,
            sha: result.sha,
            added: result.added,
            updated: result.updated,
            deleted: result.deleted,
            skippedLarge: result.skippedLarge,
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
            actingUserId,
            path.trim(),
          );
          publishFileUpdated(projectId, result.path, { draft: true });
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
          const status = await getGitStatus(project, actingUserId);
          return {
            success: true,
            branch: status.branch,
            branchProtected: (project.protectedBranches ?? []).includes(
              status.branch,
            ),
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
        "Commit working-tree changes and push them to the project's " +
        "currently tracked branch in a single commit. By default this commits " +
        "ALL pending changes (the same action as the IDE 'Commit & push' " +
        "button); pass `paths` to commit only specific changed files when " +
        "dbt_git_status shows unrelated pending work. ONLY call this after " +
        "the user has explicitly asked you to commit/push (or clearly confirmed it in the " +
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
        paths: dbtCommitPathsField,
      }),
      execute: async ({ projectId, message, paths }) => {
        try {
          const project = await assertRepoProject(projectId);
          const status = await getGitStatus(project, actingUserId);
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
            const ai = await generateDbtCommitMessage(
              project,
              {
                workspaceId,
                userId: actingUserId,
              },
              { paths },
            );
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
            userId: actingUserId,
            message: commitMessage,
            updatedBy: actingUserId,
            paths,
          });
          if (result.committed) publishGitUpdated(projectId);
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
        "commit working-tree changes onto it in a single, race-free step. By " +
        "default this commits ALL pending changes; pass `paths` to commit only " +
        "specific changed files when unrelated pending work should stay " +
        "uncommitted. " +
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
        paths: dbtCommitPathsField,
      }),
      execute: async ({ projectId, name, message, paths }) => {
        try {
          const project = await assertRepoProject(projectId);
          let commitMessage = message?.trim();
          let generated = false;
          if (!commitMessage) {
            const ai = await generateDbtCommitMessage(
              project,
              {
                workspaceId,
                userId: actingUserId,
              },
              { paths },
            );
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
            userId: actingUserId,
            branchName: name.trim(),
            message: commitMessage,
            updatedBy: actingUserId,
            paths,
          });
          if (result.committed) {
            publishGitUpdated(projectId);
            publishCheckoutUpdated(projectId, result.branch);
          }
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
          const result = await createProjectBranch(
            project,
            actingUserId,
            name.trim(),
          );
          publishCheckoutUpdated(projectId, result.branch);
          return {
            success: true,
            branch: result.branch,
            fromBranch: result.fromBranch,
          };
        } catch (error) {
          return toolError(error, "Failed to create branch");
        }
      },
    }),

    dbt_switch_branch: tool({
      description:
        "Switch the USER's checked-out branch and pull its committed contents " +
        "into the base tree. Only the acting user's checkout moves — other " +
        "collaborators keep their own branches. Uncommitted draft edits carry " +
        "over as an overlay (like `git checkout` with a dirty tree), so " +
        "nothing is lost; pass discardLocalChanges:true to drop the user's " +
        "drafts instead (only after the user explicitly confirms).",
      inputSchema: z.object({
        projectId: projectIdField,
        branch: z.string().min(1).max(255).describe("Existing branch to track"),
        discardLocalChanges: z
          .boolean()
          .optional()
          .describe(
            "Set true to throw away the user's uncommitted draft changes " +
              "before switching. Only after the user explicitly confirms.",
          ),
      }),
      execute: async ({ projectId, branch, discardLocalChanges }) => {
        try {
          const project = await assertRepoProject(projectId);
          const result = await switchProjectBranch(
            project,
            actingUserId,
            branch.trim(),
            actingUserId,
            { discardLocalChanges: discardLocalChanges ?? false },
          );
          publishCheckoutUpdated(projectId, result.branch);
          return {
            success: true,
            branch: result.branch,
            carriedChanges: result.carriedChanges,
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
          const [branches, current] = await Promise.all([
            listProjectBranches(project),
            getCheckoutBranch(project, actingUserId),
          ]);
          return {
            success: true,
            branches,
            current,
            protectedBranches: project.protectedBranches ?? [],
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
          const result = await deleteProjectBranch(
            project,
            actingUserId,
            name.trim(),
          );
          publishGitUpdated(projectId);
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
          const result = await openProjectPullRequest(project, actingUserId, {
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

    dbt_merge_pull_request: tool({
      description:
        "Merge a GitHub pull request that was opened with dbt_open_pull_request, " +
        "optionally delete its source branch, then switch the project back to " +
        "the repo's default branch and sync the merged state into the working " +
        "tree. Use when the user asks to promote/merge a PR — completes the " +
        "full ship loop without manual GitHub UI steps. Refuses before merging " +
        "if the working tree has uncommitted changes that must be committed or " +
        "moved first. Returns the merge " +
        "commit SHA, whether the branch was deleted, and confirmation the " +
        "working tree is clean on the default branch.",
      inputSchema: z.object({
        projectId: projectIdField,
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number returned by dbt_open_pull_request"),
        mergeMethod: z
          .enum(["merge", "squash", "rebase"])
          .optional()
          .describe('How to merge; defaults to "squash"'),
        deleteBranch: z
          .boolean()
          .optional()
          .describe(
            "Delete the PR's source branch after merge; defaults to true",
          ),
      }),
      execute: async ({ projectId, prNumber, mergeMethod, deleteBranch }) => {
        try {
          const project = await assertRepoProject(projectId);
          // Merging is the only write path into protected branches — gate it
          // on the admin/owner workspace role, mirroring the HTTP route RBAC.
          if (userId && !(await workspaceService.isAdmin(workspaceId, userId))) {
            return {
              success: false,
              error:
                "Merging a pull request requires the admin or owner " +
                "workspace role. Ask a workspace admin to merge it.",
            };
          }
          const result = await mergeProjectPullRequest(project, {
            userId: actingUserId,
            prNumber,
            mergeMethod,
            deleteBranch,
            updatedBy: actingUserId,
          });
          publishGitUpdated(projectId);
          publishCheckoutUpdated(projectId, result.branch);
          return {
            success: true,
            sha: result.sha,
            branchDeleted: result.branchDeleted,
            ...(result.branchDeleteWarning
              ? { branchDeleteWarning: result.branchDeleteWarning }
              : {}),
            branch: result.branch,
            workingTreeClean: result.workingTreeClean,
          };
        } catch (error) {
          return toolError(error, "Failed to merge pull request");
        }
      },
    }),

    dbt_list_pull_requests: tool({
      description:
        "List the pull requests of the project's connected repository " +
        "(defaults to open PRs; pass state to include closed/merged ones). " +
        "Returns number, title, state, merged flag, head/base branches, and " +
        "URL for each PR. Use to find a PR number before " +
        "dbt_update_pull_request, dbt_close_pull_request, or " +
        "dbt_merge_pull_request, or to report PR status to the user.",
      inputSchema: z.object({
        projectId: projectIdField,
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe('Which PRs to list; defaults to "open"'),
      }),
      execute: async ({ projectId, state }) => {
        try {
          const project = await assertRepoProject(projectId);
          const pullRequests = await listProjectPullRequests(project, {
            state,
          });
          return {
            success: true,
            // Bodies can be huge (up to 10k chars each) — truncate so a long
            // PR list doesn't blow up the chat context.
            pullRequests: pullRequests.map(pr => ({
              ...pr,
              body:
                pr.body.length > 500 ? `${pr.body.slice(0, 500)}…` : pr.body,
            })),
          };
        } catch (error) {
          return toolError(error, "Failed to list pull requests");
        }
      },
    }),

    dbt_update_pull_request: tool({
      description:
        "Update an open GitHub pull request's title, description, and/or base " +
        "branch. Provide at least one field. Use when the user wants to " +
        "retitle a PR, rewrite its description, or retarget it at a different " +
        "base branch. Returns the updated PR summary.",
      inputSchema: z.object({
        projectId: projectIdField,
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number (see dbt_list_pull_requests)"),
        title: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("New pull request title"),
        body: z
          .string()
          .max(10_000)
          .optional()
          .describe("New pull request description (Markdown)"),
        base: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("New base branch to retarget the PR at"),
      }),
      execute: async ({ projectId, prNumber, title, body, base }) => {
        try {
          const project = await assertRepoProject(projectId);
          // Editing a PR is repo-level administration (like merge/close) —
          // gate on the admin/owner role, mirroring the HTTP route RBAC.
          if (userId && !(await workspaceService.isAdmin(workspaceId, userId))) {
            return {
              success: false,
              error:
                "Updating a pull request requires the admin or owner " +
                "workspace role. Ask a workspace admin to update it.",
            };
          }
          const pr = await updateProjectPullRequest(project, {
            prNumber,
            title: title?.trim(),
            body,
            base,
          });
          return { success: true, pr };
        } catch (error) {
          return toolError(error, "Failed to update pull request");
        }
      },
    }),

    dbt_close_pull_request: tool({
      description:
        "Close a GitHub pull request WITHOUT merging it — use when the user " +
        "wants to abandon or withdraw a PR. Optionally delete its source " +
        "branch (defaults to false so the work is preserved; it refuses to " +
        "delete the project default branch or any branch a user has checked " +
        "out). To land a PR's changes instead, use dbt_merge_pull_request. " +
        "ONLY call after the user confirms the PR number.",
      inputSchema: z.object({
        projectId: projectIdField,
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number (see dbt_list_pull_requests)"),
        deleteBranch: z
          .boolean()
          .optional()
          .describe(
            "Also delete the PR's source branch; defaults to false",
          ),
      }),
      execute: async ({ projectId, prNumber, deleteBranch }) => {
        try {
          const project = await assertRepoProject(projectId);
          // Closing a PR is repo-level administration (like merge) — gate on
          // the admin/owner role, mirroring the HTTP route RBAC.
          if (userId && !(await workspaceService.isAdmin(workspaceId, userId))) {
            return {
              success: false,
              error:
                "Closing a pull request requires the admin or owner " +
                "workspace role. Ask a workspace admin to close it.",
            };
          }
          const result = await closeProjectPullRequest(project, {
            prNumber,
            deleteBranch,
          });
          if (result.branchDeleted) publishGitUpdated(projectId);
          return {
            success: true,
            pr: result.pr,
            branchDeleted: result.branchDeleted,
            ...(result.branchDeleteWarning
              ? { branchDeleteWarning: result.branchDeleteWarning }
              : {}),
          };
        } catch (error) {
          return toolError(error, "Failed to close pull request");
        }
      },
    }),
  };
};
