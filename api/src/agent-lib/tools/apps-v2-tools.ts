import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { applyStrReplace, buildStrReplaceDiff } from "@mako/agent-tools";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../../database/workspace-schema";
import { workspaceService } from "../../services/workspace.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { loggers } from "../../logging";
import {
  APP_V2_SESSION_DEFAULT_TIMEOUT_MS,
  APP_V2_SESSION_MAX_PACKAGE_COUNT,
  APP_V2_SESSION_MAX_PACKAGE_SPEC_CHARACTERS,
  APP_V2_SESSION_MAX_TIMEOUT_MS,
  isAppsV2Enabled,
} from "../../apps-v2/config";
import type {
  AppV2Actor,
  AppV2ProjectService,
} from "../../apps-v2/app-project.service";
import type { AppV2WorktreeService } from "../../apps-v2/worktree.service";
import type { AppV2SessionService } from "../../apps-v2/session.service";
import {
  getAppV2Services,
  type AppV2Services,
} from "../../apps-v2/service-factory";
import { getAppV2ProjectEventAudience } from "../../apps-v2/event-visibility";
import { isAppV2RegistryPackageSpec } from "../../apps-v2/package-spec";
import type { AgentToolExecutionContext } from "../../agents/types";
import { isValidAppV2ChatId } from "../../apps-v2/conversation-branch";
import {
  assertTurnOwnership,
  touchAppsV2ChatTurnProject,
  type AppsV2ChatTurnIdentity,
} from "../../apps-v2/chat-turn.service";

const logger = loggers.agent();
const PROVIDER_UNAVAILABLE_ERROR =
  "Apps v2 sandbox provider is unavailable. File and Git tools remain available.";

type AppV2ToolServices = {
  projects: Pick<
    AppV2ProjectService,
    "list" | "create" | "getReadable" | "getWritable"
  >;
  worktrees: Pick<
    AppV2WorktreeService,
    | "getOrCreateAgent"
    | "read"
    | "tree"
    | "write"
    | "delete"
    | "move"
    | "status"
    | "commit"
  >;
  sessions:
    | Pick<AppV2SessionService, "ensure" | "exec" | "install">
    | undefined;
};

export interface AppsV2ToolsOptions {
  workspaceId: string;
  /** Explicit request authentication mechanism; Apps v2 requires a session. */
  authType: "session" | "apiKey";
  /** A real user principal when authType is session. */
  userId?: string;
  /** Chat identity used to isolate the agent's conversation branch/worktree. */
  chatId?: string;
  /** Durable outer-turn identity used to fence conversation worktrees. */
  turnId?: string;
  executionContext?: AgentToolExecutionContext;
  services?: () => AppV2ToolServices;
  touchProject?: typeof touchAppsV2ChatTurnProject;
  assertOwnership?: typeof assertTurnOwnership;
}

function asToolServices(services: AppV2Services): AppV2ToolServices {
  return services;
}

function projectIdentity(projectId: string) {
  return { projectId, appId: projectId };
}

function worktreeMutationState(worktree: IAppV2Worktree) {
  return {
    ifRevision: worktree.revision,
    expectedWipOid: worktree.wipOid,
    leaseEpoch: worktree.leaseEpoch,
  };
}

function publishWorktreeMutation(
  workspaceId: string,
  projectId: string,
  worktree: IAppV2Worktree,
): void {
  publishRealtimeEvent(workspaceId, {
    type: "app-v2.worktree.updated",
    projectId,
    worktreeId: worktree._id.toString(),
    revision: worktree.revision,
    forUserId: worktree.actorId,
  });
}

function workspaceCwd(relativeCwd: string | undefined): string {
  return relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
}

const ProjectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("Apps v2 project ID (also returned as appId)");
const FilePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .describe("Repository-relative POSIX file path");
const RelativeCwdSchema = z
  .string()
  .max(1_024)
  .optional()
  .refine(
    cwd =>
      cwd === undefined ||
      (cwd !== "." &&
        !cwd.startsWith("/") &&
        !cwd.includes("\\") &&
        !cwd.includes("\0") &&
        !cwd.split("/").some(segment => !segment || segment === "..")),
    "cwd must stay within the project workspace",
  );

export function createAppsV2Tools({
  workspaceId,
  authType,
  userId,
  chatId,
  turnId,
  executionContext,
  services = () => asToolServices(getAppV2Services()),
  touchProject = touchAppsV2ChatTurnProject,
  assertOwnership: assertOwnershipDependency = assertTurnOwnership,
}: AppsV2ToolsOptions): ToolSet {
  if (
    !isAppsV2Enabled() ||
    authType !== "session" ||
    !userId ||
    !chatId ||
    !turnId ||
    !isValidAppV2ChatId(chatId)
  ) {
    return {};
  }

  const requestSignal = (toolSignal?: AbortSignal): AbortSignal | undefined => {
    const chatSignal = executionContext?.signal;
    if (chatSignal && toolSignal && chatSignal !== toolSignal) {
      return AbortSignal.any([chatSignal, toolSignal]);
    }
    return toolSignal ?? chatSignal;
  };

  let cachedMemberRole: string | undefined | null = null;
  const turnIdentity: AppsV2ChatTurnIdentity = {
    workspaceId,
    chatId,
    turnId,
    actorId: userId,
  };
  const touch = (projectId: string, worktree: IAppV2Worktree) =>
    touchProject(
      turnIdentity,
      projectId,
      worktree._id.toString(),
      worktree.revision,
    );
  const assertOwnership = () => assertOwnershipDependency(turnIdentity);
  const actor = async (): Promise<AppV2Actor> => {
    if (cachedMemberRole === null) {
      const member = await workspaceService.getMember(workspaceId, userId);
      cachedMemberRole = member?.role;
    }
    return { userId, memberRole: cachedMemberRole ?? undefined };
  };

  const fail = (
    label: string,
    error: unknown,
    projectId?: string,
  ): Record<string, unknown> => {
    logger.warn(`Apps v2 agent tool failed: ${label}`, {
      error,
      workspaceId,
      projectId,
    });
    return {
      success: false,
      ...(projectId ? projectIdentity(projectId) : {}),
      error: error instanceof Error ? error.message : `Failed: ${label}`,
    };
  };

  const loadWorktree = async (
    projectId: string,
    writable: boolean,
  ): Promise<{
    project: IAppV2Project;
    worktree: IAppV2Worktree;
    requestActor: AppV2Actor;
    serviceGraph: AppV2ToolServices;
  }> => {
    await assertOwnership();
    const requestActor = await actor();
    const serviceGraph = services();
    const project = writable
      ? await serviceGraph.projects.getWritable(
          workspaceId,
          projectId,
          requestActor,
        )
      : await serviceGraph.projects.getReadable(
          workspaceId,
          projectId,
          requestActor,
        );
    await assertOwnership();
    const worktree = await serviceGraph.worktrees.getOrCreateAgent(
      project,
      requestActor,
      chatId,
    );
    await assertOwnership();
    await touch(projectId, worktree);
    return { project, worktree, requestActor, serviceGraph };
  };

  const unavailable = (projectId: string) => ({
    success: false as const,
    ...projectIdentity(projectId),
    code: "provider_unavailable" as const,
    error: PROVIDER_UNAVAILABLE_ERROR,
  });

  return {
    app2_list_apps: tool({
      description:
        "List accessible Apps v2 Git-backed projects. This never lists Apps v1 documents.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        try {
          const projects = await services().projects.list(
            workspaceId,
            await actor(),
          );
          return {
            success: true,
            apps: projects.map(project => ({
              ...projectIdentity(project._id.toString()),
              title: project.title,
              description: project.description,
              updatedAt: project.updatedAt,
            })),
          };
        } catch (error) {
          return fail("app2_list_apps", error);
        }
      },
    }),

    app2_create_app: tool({
      description:
        "Create a private Apps v2 React project in its own Mako-managed Git repository.",
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(2_000).optional(),
        })
        .strict(),
      execute: async ({ title, description }) => {
        try {
          await assertOwnership();
          const requestActor = await actor();
          const serviceGraph = services();
          await assertOwnership();
          const project = await serviceGraph.projects.create(
            workspaceId,
            requestActor,
            {
              title,
              description,
              access: "private",
              workspaceRole: "viewer",
            },
          );
          await assertOwnership();
          const projectId = project._id.toString();
          const worktree = await serviceGraph.worktrees.getOrCreateAgent(
            project,
            requestActor,
            chatId,
          );
          await assertOwnership();
          await touch(projectId, worktree);
          const entries = await serviceGraph.worktrees.tree(project, worktree);
          await assertOwnership();
          publishRealtimeEvent(workspaceId, {
            type: "app-v2.project.updated",
            projectId,
            ...getAppV2ProjectEventAudience(project),
          });
          publishWorktreeMutation(workspaceId, projectId, worktree);
          return {
            success: true,
            ...projectIdentity(projectId),
            title: project.title,
            files: entries.map(entry => entry.path),
          };
        } catch (error) {
          return fail("app2_create_app", error);
        }
      },
    }),

    app2_read_file: tool({
      description:
        "Read a UTF-8 file from an Apps v2 project's latest durable personal worktree.",
      inputSchema: z
        .object({ projectId: ProjectIdSchema, path: FilePathSchema })
        .strict(),
      execute: async ({ projectId, path }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            false,
          );
          const file = await serviceGraph.worktrees.read(
            project,
            worktree,
            path,
          );
          return {
            success: true,
            ...projectIdentity(projectId),
            path: file.entry.path,
            contents: file.content,
            revision: worktree.revision,
          };
        } catch (error) {
          return fail("app2_read_file", error, projectId);
        }
      },
    }),

    app2_write_file: tool({
      description:
        "Create or fully overwrite an Apps v2 file using revision/WIP/lease compare-and-swap.",
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          path: FilePathSchema,
          contents: z.string(),
          executable: z.boolean().optional().default(false),
        })
        .strict(),
      execute: async ({ projectId, path, contents, executable }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            true,
          );
          await assertOwnership();
          const updated = await serviceGraph.worktrees.write(
            project,
            worktree,
            worktreeMutationState(worktree),
            path,
            contents,
            executable,
          );
          await assertOwnership();
          await touch(projectId, updated);
          publishWorktreeMutation(workspaceId, projectId, updated);
          return {
            success: true,
            ...projectIdentity(projectId),
            path,
            revision: updated.revision,
            wipOid: updated.wipOid,
          };
        } catch (error) {
          return fail("app2_write_file", error, projectId);
        }
      },
    }),

    app2_edit_file: tool({
      description:
        "Apply an exact anchored string replacement to an Apps v2 file and durably CAS the result.",
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          path: FilePathSchema,
          oldString: z.string().min(1),
          newString: z.string(),
          replaceAll: z.boolean().optional().default(false),
        })
        .strict(),
      execute: async ({
        projectId,
        path,
        oldString,
        newString,
        replaceAll,
      }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            true,
          );
          const file = await serviceGraph.worktrees.read(
            project,
            worktree,
            path,
          );
          const replacement = applyStrReplace(
            file.content,
            oldString,
            newString,
            replaceAll,
          );
          if (!replacement.ok) {
            return {
              success: false,
              ...projectIdentity(projectId),
              error: replacement.error,
            };
          }
          await assertOwnership();
          const updated = await serviceGraph.worktrees.write(
            project,
            worktree,
            worktreeMutationState(worktree),
            path,
            replacement.contents,
            file.entry.mode === "executable",
          );
          await assertOwnership();
          await touch(projectId, updated);
          publishWorktreeMutation(workspaceId, projectId, updated);
          return {
            success: true,
            ...projectIdentity(projectId),
            path,
            replacements: replacement.replacements,
            diff: buildStrReplaceDiff(
              file.content,
              oldString,
              newString,
              replacement.replacements,
            ),
            revision: updated.revision,
            wipOid: updated.wipOid,
          };
        } catch (error) {
          return fail("app2_edit_file", error, projectId);
        }
      },
    }),

    app2_delete_file: tool({
      description:
        "Delete a file from an Apps v2 durable worktree using revision/WIP/lease CAS.",
      inputSchema: z
        .object({ projectId: ProjectIdSchema, path: FilePathSchema })
        .strict(),
      execute: async ({ projectId, path }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            true,
          );
          await assertOwnership();
          const updated = await serviceGraph.worktrees.delete(
            project,
            worktree,
            worktreeMutationState(worktree),
            path,
          );
          await assertOwnership();
          await touch(projectId, updated);
          publishWorktreeMutation(workspaceId, projectId, updated);
          return {
            success: true,
            ...projectIdentity(projectId),
            path,
            revision: updated.revision,
            wipOid: updated.wipOid,
          };
        } catch (error) {
          return fail("app2_delete_file", error, projectId);
        }
      },
    }),

    app2_move_file: tool({
      description:
        "Move or rename a file in an Apps v2 durable worktree using revision/WIP/lease CAS.",
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          from: FilePathSchema,
          to: FilePathSchema,
        })
        .strict(),
      execute: async ({ projectId, from, to }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            true,
          );
          await assertOwnership();
          const updated = await serviceGraph.worktrees.move(
            project,
            worktree,
            worktreeMutationState(worktree),
            from,
            to,
          );
          await assertOwnership();
          await touch(projectId, updated);
          publishWorktreeMutation(workspaceId, projectId, updated);
          return {
            success: true,
            ...projectIdentity(projectId),
            from,
            to,
            revision: updated.revision,
            wipOid: updated.wipOid,
          };
        } catch (error) {
          return fail("app2_move_file", error, projectId);
        }
      },
    }),

    app2_status: tool({
      description:
        "Show changed files in an Apps v2 personal durable worktree relative to its branch base.",
      inputSchema: z.object({ projectId: ProjectIdSchema }).strict(),
      execute: async ({ projectId }) => {
        try {
          const { project, worktree, serviceGraph } = await loadWorktree(
            projectId,
            false,
          );
          const status = await serviceGraph.worktrees.status(project, worktree);
          return {
            success: true,
            ...projectIdentity(projectId),
            worktreeId: worktree._id.toString(),
            revision: worktree.revision,
            wipOid: worktree.wipOid,
            baseSha: worktree.baseSha,
            ...status,
          };
        } catch (error) {
          return fail("app2_status", error, projectId);
        }
      },
    }),

    app2_commit: tool({
      description:
        "Commit the current Apps v2 WIP snapshot to its branch with compare-and-swap.",
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          message: z.string().trim().min(1).max(500),
        })
        .strict(),
      execute: async ({ projectId, message }) => {
        try {
          const { project, worktree, requestActor, serviceGraph } =
            await loadWorktree(projectId, true);
          await assertOwnership();
          const result = await serviceGraph.worktrees.commit(
            project,
            worktree,
            worktreeMutationState(worktree),
            message,
            requestActor,
          );
          await assertOwnership();
          await touch(projectId, result.worktree);
          publishWorktreeMutation(workspaceId, projectId, result.worktree);
          publishRealtimeEvent(workspaceId, {
            type: "app-v2.commit.created",
            projectId,
            worktreeId: result.worktree._id.toString(),
            sha: result.sha,
            forUserId: userId,
          });
          return {
            success: true,
            ...projectIdentity(projectId),
            sha: result.sha,
            revision: result.worktree.revision,
            wipOid: result.worktree.wipOid,
          };
        } catch (error) {
          return fail("app2_commit", error, projectId);
        }
      },
    }),

    app2_bash: tool({
      description:
        'Run real Bash semantics in the secure Apps v2 sandbox with argv ["bash","-lc",command]. Source changes are flushed to durable WIP afterward.',
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          command: z.string().min(1).max(8_192),
          cwd: RelativeCwdSchema,
          timeoutMs: z
            .number()
            .int()
            .positive()
            .max(APP_V2_SESSION_MAX_TIMEOUT_MS)
            .optional()
            .default(APP_V2_SESSION_DEFAULT_TIMEOUT_MS),
        })
        .strict(),
      execute: async (
        { projectId, command, cwd, timeoutMs },
        { abortSignal },
      ) => {
        try {
          const signal = requestSignal(abortSignal);
          const loaded = await loadWorktree(projectId, true);
          if (!loaded.serviceGraph.sessions) return unavailable(projectId);
          await assertOwnership();
          const ensured = await loaded.serviceGraph.sessions.ensure(
            loaded.project,
            loaded.worktree,
            loaded.requestActor,
            signal,
          );
          await assertOwnership();
          const result = await loaded.serviceGraph.sessions.exec(
            loaded.project,
            ensured.worktree,
            loaded.requestActor,
            {
              argv: ["bash", "-lc", command],
              cwd: workspaceCwd(cwd),
              timeoutMs,
              signal,
            },
          );
          await assertOwnership();
          if (result.durability.status === "durable") {
            await touchProject(
              turnIdentity,
              projectId,
              ensured.worktree._id.toString(),
              result.durability.revision.revision,
            );
            publishRealtimeEvent(workspaceId, {
              type: "app-v2.worktree.updated",
              projectId,
              worktreeId: ensured.worktree._id.toString(),
              revision: result.durability.revision.revision,
              forUserId: ensured.worktree.actorId,
            });
          }
          return {
            success:
              result.exitCode === 0 && result.durability.status === "durable",
            ...projectIdentity(projectId),
            result,
            sourceFlush: result.durability,
          };
        } catch (error) {
          return fail("app2_bash", error, projectId);
        }
      },
    }),

    app2_install_packages: tool({
      description:
        "Install public npm registry packages through the dedicated secure Apps v2 install operation. Never accepts URLs, paths, Git, or shell syntax.",
      inputSchema: z
        .object({
          projectId: ProjectIdSchema,
          packages: z
            .array(
              z
                .string()
                .min(1)
                .max(APP_V2_SESSION_MAX_PACKAGE_SPEC_CHARACTERS)
                .refine(
                  isAppV2RegistryPackageSpec,
                  "Must be a public npm registry package spec",
                ),
            )
            .min(1)
            .max(APP_V2_SESSION_MAX_PACKAGE_COUNT),
        })
        .strict(),
      execute: async ({ projectId, packages }, { abortSignal }) => {
        try {
          const signal = requestSignal(abortSignal);
          const loaded = await loadWorktree(projectId, true);
          if (!loaded.serviceGraph.sessions) return unavailable(projectId);
          await assertOwnership();
          const ensured = await loaded.serviceGraph.sessions.ensure(
            loaded.project,
            loaded.worktree,
            loaded.requestActor,
            signal,
          );
          await assertOwnership();
          const result = await loaded.serviceGraph.sessions.install(
            loaded.project,
            ensured.worktree,
            loaded.requestActor,
            { packages, signal },
          );
          await assertOwnership();
          if (result.durability.status === "durable") {
            await touchProject(
              turnIdentity,
              projectId,
              ensured.worktree._id.toString(),
              result.durability.revision.revision,
            );
            publishRealtimeEvent(workspaceId, {
              type: "app-v2.worktree.updated",
              projectId,
              worktreeId: ensured.worktree._id.toString(),
              revision: result.durability.revision.revision,
              forUserId: ensured.worktree.actorId,
            });
          }
          return {
            success:
              result.exitCode === 0 && result.durability.status === "durable",
            ...projectIdentity(projectId),
            result,
            sourceFlush: result.durability,
          };
        } catch (error) {
          return fail("app2_install_packages", error, projectId);
        }
      },
    }),
  };
}
