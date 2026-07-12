/**
 * Apps v2 Git-native project and private worktree routes.
 *
 * Classification: authenticated + workspace-scoped. This router is entirely
 * separate from Apps v1 and is hidden behind APPS_V2_ENABLED.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import {
  AppV2CommitSchema,
  AppV2DeleteFileSchema,
  AppV2DiscardSchema,
  AppV2LeaseRotateSchema,
  AppV2MoveFileSchema,
  AppV2ProjectCreateSchema,
  AppV2WriteFileSchema,
} from "@mako/schemas";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  requireWorkspace,
  type AuthenticatedContext,
} from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonContent,
  zDateTime,
} from "../openapi/core";
import { publishRealtimeEvent } from "../services/realtime.service";
import {
  AppV2ProjectService,
  type AppV2Actor,
} from "../apps-v2/app-project.service";
import { getAppV2ProjectEventAudience } from "../apps-v2/event-visibility";
import { resolveResourceRole } from "../utils/resource-acl";
import {
  APP_V2_MAX_REQUEST_BYTES,
  APP_V2_SESSION_DEFAULT_TIMEOUT_MS,
  APP_V2_SESSION_MAX_ARG_CHARACTERS,
  APP_V2_SESSION_MAX_ARG_COUNT,
  APP_V2_SESSION_MAX_TIMEOUT_MS,
  getAppsV2SandboxConfiguration,
  isAppsV2Enabled,
} from "../apps-v2/config";
import {
  AppV2ConflictError,
  AppV2LimitError,
  AppV2NotFoundError,
  AppV2OperationConflictError,
  AppV2ProviderUnavailableError,
  AppV2RecoveryConflictError,
  AppV2ValidationError,
} from "../apps-v2/errors";
import { AppV2WorktreeService } from "../apps-v2/worktree.service";
import { CloudSessionExecutor } from "../apps-v2/cloud-session-executor";
import { AppV2SessionService } from "../apps-v2/session.service";
import { createAppsV2SandboxProvider } from "../apps-v2/providers/sandbox-provider-factory";
import { APP_V2_MAX_PATH_SEGMENTS } from "../apps-v2/path-validation";

const logger = loggers.api("apps-v2");
const routes = createRouter();
let projectService: AppV2ProjectService | undefined;
let worktreeService: AppV2WorktreeService | undefined;
let sessionService: AppV2SessionService | undefined;

const WorkspaceParams = z.object({
  workspaceId: z
    .string()
    .max(128)
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const ProjectParams = WorkspaceParams.extend({
  projectId: z
    .string()
    .max(128)
    .openapi({ param: { name: "projectId", in: "path" } }),
});
const WorktreeParams = ProjectParams.extend({
  worktreeId: z
    .string()
    .max(128)
    .openapi({ param: { name: "worktreeId", in: "path" } }),
});
const CommitParams = ProjectParams.extend({
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .openapi({ param: { name: "sha", in: "path" } }),
});
const FileQuery = z.object({
  path: z
    .string()
    .min(1)
    .max(1_024)
    .openapi({ param: { name: "path", in: "query" } }),
});
const CommitListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .openapi({ param: { name: "limit", in: "query" } }),
});
const AppV2SessionExecSchema = z
  .object({
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(APP_V2_SESSION_MAX_ARG_CHARACTERS)
          .refine(argument => !argument.includes("\0"), "NUL is not allowed"),
      )
      .min(1)
      .max(APP_V2_SESSION_MAX_ARG_COUNT)
      .refine(
        argv =>
          argv.reduce((total, argument) => total + argument.length, 0) <=
          APP_V2_SESSION_MAX_ARG_CHARACTERS,
        "Combined argv is too long",
      ),
    cwd: z
      .string()
      .max(1_024)
      .default("")
      .refine(
        cwd =>
          !cwd.startsWith("/") &&
          !cwd.includes("\\") &&
          !cwd.includes("\0") &&
          (cwd === "" ||
            (cwd.split("/").length <= APP_V2_MAX_PATH_SEGMENTS &&
              !cwd
                .split("/")
                .some(
                  segment => !segment || segment === "." || segment === "..",
                ))),
        "cwd must stay within /workspace",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(APP_V2_SESSION_MAX_TIMEOUT_MS)
      .default(APP_V2_SESSION_DEFAULT_TIMEOUT_MS),
  })
  .openapi("AppV2SessionExec");

const AppV2StatusResponseSchema = z
  .object({ enabled: z.boolean() })
  .openapi("AppV2StatusResponse");
const AppV2ProjectSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    access: z.enum(["private", "workspace"]),
    workspaceRole: z.enum(["viewer", "editor"]),
    sharedWith: z.array(
      z.object({
        userId: z.string(),
        role: z.enum(["viewer", "editor"]),
        addedAt: zDateTime().optional(),
      }),
    ),
    ownerId: z.string(),
    effectiveRole: z.enum(["owner", "editor", "viewer"]),
    readOnly: z.boolean(),
    repositoryProvider: z.literal("mako-git"),
    repositoryId: z.string(),
    defaultBranch: z.string(),
    headSha: z.string(),
    createdAt: zDateTime(),
    updatedAt: zDateTime(),
  })
  .openapi("AppV2Project");
const AppV2WorktreeSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    actorId: z.string(),
    branch: z.string(),
    baseSha: z.string(),
    wipOid: z.string(),
    revision: z.number().int(),
    leaseEpoch: z.number().int(),
    status: z.enum(["active", "discarded", "fenced"]),
    createdAt: zDateTime(),
    updatedAt: zDateTime(),
  })
  .openapi("AppV2Worktree");
const AppV2TreeEntrySchema = z
  .object({
    path: z.string(),
    oid: z.string(),
    size: z.number().int(),
    mode: z.enum(["regular", "executable"]),
  })
  .openapi("AppV2TreeEntry");
const AppV2ChangeSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.string(),
  })
  .openapi("AppV2Change");
const AppV2CommitMetadataSchema = z
  .object({
    sha: z.string(),
    treeSha: z.string(),
    parentShas: z.array(z.string()),
    authorName: z.string(),
    authorEmail: z.string(),
    authoredAt: zDateTime(),
    message: z.string(),
    stats: z.object({
      filesChanged: z.number().int(),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  })
  .openapi("AppV2CommitMetadata");
const AppV2ProjectResponseSchema = z
  .object({ success: z.literal(true), project: AppV2ProjectSchema })
  .openapi("AppV2ProjectResponse");
const AppV2ProjectListResponseSchema = z
  .object({ success: z.literal(true), projects: z.array(AppV2ProjectSchema) })
  .openapi("AppV2ProjectListResponse");
const AppV2WorktreeResponseSchema = z
  .object({ success: z.literal(true), worktree: AppV2WorktreeSchema })
  .openapi("AppV2WorktreeResponse");
const AppV2TreeResponseSchema = z
  .object({
    success: z.literal(true),
    worktree: AppV2WorktreeSchema,
    entries: z.array(AppV2TreeEntrySchema),
  })
  .openapi("AppV2TreeResponse");
const AppV2FileResponseSchema = z
  .object({
    success: z.literal(true),
    path: z.string(),
    oid: z.string(),
    mode: z.enum(["regular", "executable"]),
    content: z.string(),
    worktree: AppV2WorktreeSchema,
  })
  .openapi("AppV2FileResponse");
const AppV2WorktreeStatusResponseSchema = z
  .object({
    success: z.literal(true),
    worktree: AppV2WorktreeSchema,
    clean: z.boolean(),
    changes: z.array(AppV2ChangeSchema),
  })
  .openapi("AppV2WorktreeStatusResponse");
const AppV2CommitResponseSchema = AppV2WorktreeResponseSchema.extend({
  sha: z.string(),
}).openapi("AppV2CommitResponse");
const AppV2CommitListResponseSchema = z
  .object({
    success: z.literal(true),
    commits: z.array(AppV2CommitMetadataSchema),
  })
  .openapi("AppV2CommitListResponse");
const AppV2CommitDetailResponseSchema = z
  .object({
    success: z.literal(true),
    commit: AppV2CommitMetadataSchema,
  })
  .openapi("AppV2CommitDetailResponse");
const AppV2AckResponseSchema = z
  .object({ success: z.literal(true) })
  .openapi("AppV2AckResponse");
const AppV2SessionSchema = z
  .object({
    id: z.string().optional(),
    worktreeId: z.string(),
    provider: z.string(),
    sandboxId: z.string(),
    generation: z.number().int().nonnegative(),
    leaseEpoch: z.number().int(),
    appliedWipOid: z.string(),
    recoveryRef: z.string().optional(),
    status: z.enum([
      "active",
      "paused",
      "unsynced",
      "conflict",
      "provisioning",
      "revoked",
      "destroyed",
      "error",
    ]),
    lastActiveAt: zDateTime(),
  })
  .openapi("AppV2Session");
const AppV2SessionDurabilitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("durable"),
    revision: z.object({ wipOid: z.string(), revision: z.number().int() }),
  }),
  z.object({
    status: z.literal("conflict"),
    recoveryRef: z.string(),
  }),
]);
const AppV2SessionResponseSchema = z
  .object({
    success: z.literal(true),
    session: AppV2SessionSchema,
    worktree: AppV2WorktreeSchema.optional(),
  })
  .openapi("AppV2SessionResponse");
const AppV2SessionExecResponseSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    result: z.object({
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      timedOut: z.boolean(),
      cancelled: z.boolean(),
      outputTruncated: z.boolean(),
      excludedPaths: z.array(z.string()),
      durability: AppV2SessionDurabilitySchema,
    }),
  })
  .openapi("AppV2SessionExecResponse");
const AppV2SessionFlushSchema = z.object({
  excludedPaths: z.array(z.string()),
  durability: AppV2SessionDurabilitySchema,
});
const AppV2SessionLifecycleResponseSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    session: AppV2SessionSchema,
    worktree: AppV2WorktreeSchema,
    flush: AppV2SessionFlushSchema,
  })
  .openapi("AppV2SessionLifecycleResponse");
const ProviderUnavailableResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    code: z.literal("provider_unavailable"),
  })
  .openapi("AppV2ProviderUnavailableResponse");
const AppV2SessionConflictResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    retryable: z.boolean().optional(),
    recoveryRef: z.string().optional(),
  })
  .openapi("AppV2SessionConflictResponse");

const okResponse = (schema: z.ZodType, description: string) => ({
  ...OPEN_RESPONSES,
  200: jsonContent(schema, description),
});

function services(): {
  projects: AppV2ProjectService;
  worktrees: AppV2WorktreeService;
} {
  projectService ??= new AppV2ProjectService();
  worktreeService ??= new AppV2WorktreeService(projectService);
  return { projects: projectService, worktrees: worktreeService };
}

function sessions(): AppV2SessionService | undefined {
  const configuration = getAppsV2SandboxConfiguration();
  if (!configuration.available) return undefined;
  if (!sessionService) {
    const provider = createAppsV2SandboxProvider();
    if (!provider) return undefined;
    sessionService = new AppV2SessionService(
      provider.name,
      new CloudSessionExecutor(
        provider,
        services().projects,
        services().worktrees,
      ),
      services().worktrees,
    );
  }
  return sessionService;
}

function actor(c: AuthenticatedContext) {
  const userId = c.get("user")?.id;
  if (!userId) throw new AppV2NotFoundError("Project not found");
  return { userId, memberRole: c.get("memberRole") };
}

function projectJson(project: IAppV2Project, requestActor: AppV2Actor) {
  const effectiveRole =
    resolveResourceRole(
      project,
      requestActor.userId,
      requestActor.memberRole,
    ) ?? "viewer";
  return {
    id: project._id.toString(),
    workspaceId: project.workspaceId.toString(),
    title: project.title,
    description: project.description,
    access: project.access,
    workspaceRole: project.workspaceRole,
    sharedWith: project.sharedWith,
    ownerId: project.owner_id,
    effectiveRole,
    readOnly: effectiveRole === "viewer",
    repositoryProvider: project.repositoryProvider,
    repositoryId: project.repositoryId,
    defaultBranch: project.defaultBranch,
    headSha: project.headSha,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function worktreeJson(worktree: IAppV2Worktree) {
  return {
    id: worktree._id.toString(),
    projectId: worktree.projectId.toString(),
    actorId: worktree.actorId,
    branch: worktree.branch,
    baseSha: worktree.baseSha,
    wipOid: worktree.wipOid,
    revision: worktree.revision,
    leaseEpoch: worktree.leaseEpoch,
    status: worktree.status,
    createdAt: worktree.createdAt,
    updatedAt: worktree.updatedAt,
  };
}

function sessionJson(session: Awaited<ReturnType<AppV2SessionService["get"]>>) {
  return {
    id: session.id,
    worktreeId: session.worktreeId,
    provider: session.provider,
    sandboxId: session.sandboxId,
    generation: session.generation,
    leaseEpoch: session.leaseEpoch,
    appliedWipOid: session.appliedWipOid,
    recoveryRef: session.recoveryRef,
    status: session.status,
    lastActiveAt: session.lastActiveAt,
  };
}

function unavailableProvider(c: AuthenticatedContext) {
  return c.json(
    {
      success: false as const,
      error: "Apps v2 sandbox provider is unavailable",
      code: "provider_unavailable" as const,
    },
    503,
  );
}

function workspaceCwd(relativeCwd: string): string {
  return relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
}

function mutationPoke(
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

function errorResponse(c: AuthenticatedContext, error: unknown) {
  if (error instanceof AppV2ProviderUnavailableError) {
    return c.json(
      {
        success: false as const,
        error: error.message,
        code: "provider_unavailable" as const,
      },
      503,
    );
  }
  if (error instanceof AppV2RecoveryConflictError) {
    return c.json(
      {
        success: false as const,
        error: error.message,
        recoveryRef: error.recoveryRef,
      },
      409,
    );
  }
  if (error instanceof AppV2OperationConflictError) {
    return c.json(
      {
        success: false as const,
        error: error.message,
        retryable: error.retryable,
      },
      409,
    );
  }
  if (error instanceof AppV2ConflictError) {
    return c.json({ success: false, error: error.message }, 409);
  }
  if (error instanceof AppV2NotFoundError) {
    return c.json({ success: false, error: error.message }, 404);
  }
  if (error instanceof AppV2LimitError) {
    return c.json({ success: false, error: error.message }, 400);
  }
  if (error instanceof AppV2ValidationError) {
    return c.json({ success: false, error: error.message }, 400);
  }
  logger.error("Apps v2 request failed", { error });
  return c.json({ success: false, error: "Apps v2 request failed" }, 500);
}

routes.use("*", unifiedAuthMiddleware);
routes.use("*", requireWorkspace);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/session/flush",
    tags: ["Apps v2"],
    summary: "Flush the actor's Apps v2 sandbox session to durable WIP",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(
        AppV2SessionLifecycleResponseSchema,
        "Durable sandbox session flush",
      ),
      409: jsonContent(
        z.union([
          AppV2SessionLifecycleResponseSchema,
          AppV2SessionConflictResponseSchema,
        ]),
        "Captured source was retained on a recovery ref after a WIP conflict",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    if (!isAppsV2Enabled()) {
      return c.json(
        { success: false, error: "Apps v2 feature is unavailable" },
        404,
      );
    }
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const flushed = await sessionController.flush(
        project,
        worktree,
        requestActor,
      );
      const body = {
        success: flushed.flush.durability.status === "durable",
        error:
          flushed.flush.durability.status === "conflict"
            ? "Captured source retained; durable WIP flush conflicted"
            : undefined,
        session: sessionJson(flushed.session),
        worktree: worktreeJson(flushed.worktree),
        flush: flushed.flush,
      };
      if (flushed.flush.durability.status === "conflict") {
        return c.json(body, 409);
      }
      mutationPoke(workspaceId, projectId, flushed.worktree);
      return c.json(body, 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/status",
    tags: ["Apps v2"],
    summary: "Get Apps v2 feature availability",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParams },
    responses: {
      ...OPEN_RESPONSES,
      200: jsonContent(
        AppV2StatusResponseSchema,
        "Apps v2 feature availability",
      ),
    },
  }),
  c => c.json({ enabled: isAppsV2Enabled() }),
);

routes.use("*", async (c, next) => {
  if (!isAppsV2Enabled()) {
    return c.json(
      { success: false, error: "Apps v2 feature is unavailable" },
      404,
    );
  }
  await next();
});
routes.use(
  "*",
  bodyLimit({
    maxSize: APP_V2_MAX_REQUEST_BYTES,
    onError: c =>
      c.json(
        { success: false, error: "Apps v2 request body is too large" },
        413,
      ),
  }),
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Apps v2"],
    summary: "List accessible Apps v2 projects",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParams },
    responses: okResponse(
      AppV2ProjectListResponseSchema,
      "Accessible Apps v2 projects",
    ),
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const requestActor = actor(c);
      const projects = await services().projects.list(
        workspaceId,
        requestActor,
      );
      return c.json({
        success: true,
        projects: projects.map(project => projectJson(project, requestActor)),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Apps v2"],
    summary: "Create an Apps v2 project and Git repository",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2ProjectCreateSchema } },
      },
    },
    responses: {
      ...OPEN_RESPONSES,
      201: jsonContent(AppV2ProjectResponseSchema, "Created Apps v2 project"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const requestActor = actor(c);
      const project = await services().projects.create(
        workspaceId,
        requestActor,
        c.req.valid("json"),
      );
      publishRealtimeEvent(workspaceId, {
        type: "app-v2.project.updated",
        projectId: project._id.toString(),
        ...getAppV2ProjectEventAudience(project),
      });
      return c.json(
        { success: true, project: projectJson(project, requestActor) },
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}",
    tags: ["Apps v2"],
    summary: "Get an Apps v2 project",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: okResponse(AppV2ProjectResponseSchema, "Apps v2 project"),
  }),
  async c => {
    try {
      const { workspaceId, projectId } = c.req.valid("param");
      const requestActor = actor(c);
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      return c.json({
        success: true,
        project: projectJson(project, requestActor),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}",
    tags: ["Apps v2"],
    summary: "Delete an Apps v2 project",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(AppV2AckResponseSchema, "Project deleted"),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Active sandbox provider unavailable; deletion remains retryable",
      ),
    },
  }),
  async c => {
    try {
      const { workspaceId, projectId } = c.req.valid("param");
      const requestActor = actor(c);
      const deletedProject = await services().projects.delete(
        workspaceId,
        projectId,
        requestActor,
      );
      publishRealtimeEvent(workspaceId, {
        type: "app-v2.project.deleted",
        projectId,
        ...getAppV2ProjectEventAudience(deletedProject),
      });
      return c.json({ success: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

for (const method of ["get", "post"] as const) {
  routes.openapi(
    createRoute({
      method,
      path: "/{projectId}/worktree",
      tags: ["Apps v2"],
      summary:
        method === "get"
          ? "Get the actor's Apps v2 worktree"
          : "Create or get the actor's Apps v2 worktree",
      security: AUTH_SECURITY,
      request: { params: ProjectParams },
      responses: okResponse(
        AppV2WorktreeResponseSchema,
        "Personal Apps v2 worktree",
      ),
    }),
    async c => {
      try {
        const requestActor = actor(c);
        const { workspaceId, projectId } = c.req.valid("param");
        const project = await services().projects.getReadable(
          workspaceId,
          projectId,
          requestActor,
        );
        const worktree =
          method === "post"
            ? await services().worktrees.getOrCreate(project, requestActor)
            : await services().worktrees.getActorWorktree(
                project,
                requestActor,
              );
        if (method === "post") {
          mutationPoke(workspaceId, project._id.toString(), worktree);
        }
        return c.json({ success: true, worktree: worktreeJson(worktree) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );
}

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/worktree/lease",
    tags: ["Apps v2"],
    summary: "Rotate the actor worktree fencing lease",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2LeaseRotateSchema } },
      },
    },
    responses: okResponse(
      AppV2WorktreeResponseSchema,
      "Rotated personal worktree lease",
    ),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const updated = await services().worktrees.rotateLease(
        project,
        worktree,
        c.req.valid("json"),
      );
      mutationPoke(workspaceId, project._id.toString(), updated);
      return c.json({ success: true, worktree: worktreeJson(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/session",
    tags: ["Apps v2"],
    summary: "Get the actor's Apps v2 sandbox session",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(AppV2SessionResponseSchema, "Apps v2 sandbox session"),
      409: jsonContent(
        AppV2SessionConflictResponseSchema,
        "Another session operation is in progress",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const session = await sessionController.get(
        project,
        worktree,
        requestActor,
      );
      return c.json({ success: true as const, session: sessionJson(session) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/session",
    tags: ["Apps v2"],
    summary: "Ensure the actor's Apps v2 sandbox session",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(AppV2SessionResponseSchema, "Apps v2 sandbox session"),
      409: jsonContent(
        AppV2SessionConflictResponseSchema,
        "Session provisioning is in progress or recovery is required",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getOrCreate(
        project,
        requestActor,
      );
      const ensured = await sessionController.ensure(
        project,
        worktree,
        requestActor,
      );
      mutationPoke(workspaceId, projectId, ensured.worktree);
      return c.json({
        success: true as const,
        session: sessionJson(ensured.session),
        worktree: worktreeJson(ensured.worktree),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/session/exec",
    tags: ["Apps v2"],
    summary: "Run a finite argv command in an Apps v2 sandbox session",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2SessionExecSchema } },
      },
    },
    responses: {
      ...okResponse(AppV2SessionExecResponseSchema, "Finite command result"),
      409: jsonContent(
        z.union([
          AppV2SessionExecResponseSchema,
          AppV2SessionConflictResponseSchema,
        ]),
        "Command flush conflicted, recovery is required, or another operation is in progress",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const result = await sessionController.exec(
        project,
        worktree,
        requestActor,
        {
          argv: input.argv,
          cwd: workspaceCwd(input.cwd),
          timeoutMs: input.timeoutMs,
          signal: c.req.raw.signal,
        },
      );
      if (result.durability.status === "conflict") {
        return c.json(
          {
            success: false,
            error: "Command output retained; durable WIP flush conflicted",
            result,
          },
          409,
        );
      }
      publishRealtimeEvent(workspaceId, {
        type: "app-v2.worktree.updated",
        projectId,
        worktreeId: worktree._id.toString(),
        revision: result.durability.revision?.revision ?? worktree.revision,
        forUserId: worktree.actorId,
      });
      return c.json({ success: true, result });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/session/pause",
    tags: ["Apps v2"],
    summary: "Pause the actor's Apps v2 sandbox session",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(
        AppV2SessionLifecycleResponseSchema,
        "Paused sandbox session",
      ),
      409: jsonContent(
        AppV2SessionConflictResponseSchema,
        "Another session operation is in progress",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const paused = await sessionController.pause(
        project,
        worktree,
        requestActor,
      );
      const body = {
        success: true,
        session: sessionJson(paused.session),
        worktree: worktreeJson(paused.worktree),
        flush: paused.flush,
      };
      return c.json(body, 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}/session",
    tags: ["Apps v2"],
    summary: "Destroy and fence the actor's Apps v2 sandbox session",
    security: AUTH_SECURITY,
    request: { params: ProjectParams },
    responses: {
      ...okResponse(
        AppV2SessionLifecycleResponseSchema,
        "Destroyed sandbox session",
      ),
      409: jsonContent(
        z.union([
          AppV2SessionLifecycleResponseSchema,
          AppV2SessionConflictResponseSchema,
        ]),
        "Session was retained because its flush conflicted or another operation is in progress",
      ),
      503: jsonContent(
        ProviderUnavailableResponseSchema,
        "Sandbox provider unavailable",
      ),
    },
  }),
  async c => {
    const sessionController = sessions();
    if (!sessionController) return unavailableProvider(c);
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getActorWorktree(
        project,
        requestActor,
      );
      const destroyed = await sessionController.destroy(
        project,
        worktree,
        requestActor,
      );
      const body = {
        success: destroyed.session.status === "destroyed",
        error:
          destroyed.flush.durability.status === "conflict" &&
          destroyed.session.status !== "destroyed"
            ? "Session was retained because its durable WIP flush conflicted"
            : undefined,
        session: sessionJson(destroyed.session),
        worktree: worktreeJson(destroyed.worktree),
        flush: destroyed.flush,
      };
      if (destroyed.session.status !== "destroyed") {
        return c.json(body, 409);
      }
      mutationPoke(workspaceId, projectId, destroyed.worktree);
      return c.json(body, 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/worktrees/{worktreeId}/tree",
    tags: ["Apps v2"],
    summary: "Read a durable worktree tree",
    security: AUTH_SECURITY,
    request: { params: WorktreeParams },
    responses: okResponse(AppV2TreeResponseSchema, "Worktree file tree"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const entries = await services().worktrees.tree(project, worktree);
      return c.json({
        success: true,
        worktree: worktreeJson(worktree),
        entries,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/worktrees/{worktreeId}/file",
    tags: ["Apps v2"],
    summary: "Read a UTF-8 worktree file",
    security: AUTH_SECURITY,
    request: { params: WorktreeParams, query: FileQuery },
    responses: okResponse(AppV2FileResponseSchema, "UTF-8 worktree file"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const file = await services().worktrees.read(
        project,
        worktree,
        c.req.valid("query").path,
      );
      return c.json({
        success: true,
        path: file.entry.path,
        oid: file.entry.oid,
        mode: file.entry.mode,
        content: file.content,
        worktree: worktreeJson(worktree),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "put",
    path: "/{projectId}/worktrees/{worktreeId}/file",
    tags: ["Apps v2"],
    summary: "Write a UTF-8 worktree file",
    security: AUTH_SECURITY,
    request: {
      params: WorktreeParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2WriteFileSchema } },
      },
    },
    responses: okResponse(AppV2WorktreeResponseSchema, "Updated worktree"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const input = c.req.valid("json");
      const updated = await services().worktrees.write(
        project,
        worktree,
        input,
        input.path,
        input.content,
        input.executable,
      );
      mutationPoke(workspaceId, project._id.toString(), updated);
      return c.json({ success: true, worktree: worktreeJson(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "delete",
    path: "/{projectId}/worktrees/{worktreeId}/file",
    tags: ["Apps v2"],
    summary: "Delete a worktree file",
    security: AUTH_SECURITY,
    request: {
      params: WorktreeParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2DeleteFileSchema } },
      },
    },
    responses: okResponse(AppV2WorktreeResponseSchema, "Updated worktree"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const input = c.req.valid("json");
      const updated = await services().worktrees.delete(
        project,
        worktree,
        input,
        input.path,
      );
      mutationPoke(workspaceId, project._id.toString(), updated);
      return c.json({ success: true, worktree: worktreeJson(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/worktrees/{worktreeId}/move",
    tags: ["Apps v2"],
    summary: "Move a worktree file",
    security: AUTH_SECURITY,
    request: {
      params: WorktreeParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2MoveFileSchema } },
      },
    },
    responses: okResponse(AppV2WorktreeResponseSchema, "Updated worktree"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const input = c.req.valid("json");
      const updated = await services().worktrees.move(
        project,
        worktree,
        input,
        input.from,
        input.to,
      );
      mutationPoke(workspaceId, project._id.toString(), updated);
      return c.json({ success: true, worktree: worktreeJson(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/worktrees/{worktreeId}/status",
    tags: ["Apps v2"],
    summary: "Get durable Git worktree status",
    security: AUTH_SECURITY,
    request: { params: WorktreeParams },
    responses: okResponse(
      AppV2WorktreeStatusResponseSchema,
      "Durable Git worktree status",
    ),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const status = await services().worktrees.status(project, worktree);
      return c.json({
        success: true,
        worktree: worktreeJson(worktree),
        ...status,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/worktrees/{worktreeId}/discard",
    tags: ["Apps v2"],
    summary: "Discard durable worktree changes",
    security: AUTH_SECURITY,
    request: {
      params: WorktreeParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2DiscardSchema } },
      },
    },
    responses: okResponse(AppV2WorktreeResponseSchema, "Discarded worktree"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const updated = await services().worktrees.discard(
        project,
        worktree,
        c.req.valid("json"),
      );
      mutationPoke(workspaceId, project._id.toString(), updated);
      return c.json({ success: true, worktree: worktreeJson(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "post",
    path: "/{projectId}/worktrees/{worktreeId}/commit",
    tags: ["Apps v2"],
    summary: "Commit a durable worktree",
    security: AUTH_SECURITY,
    request: {
      params: WorktreeParams,
      body: {
        required: true,
        content: { "application/json": { schema: AppV2CommitSchema } },
      },
    },
    responses: okResponse(AppV2CommitResponseSchema, "Created Git commit"),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, worktreeId } = c.req.valid("param");
      const project = await services().projects.getWritable(
        workspaceId,
        projectId,
        requestActor,
      );
      const worktree = await services().worktrees.getById(
        project,
        worktreeId,
        requestActor,
      );
      const input = c.req.valid("json");
      const result = await services().worktrees.commit(
        project,
        worktree,
        input,
        input.message,
        requestActor,
      );
      mutationPoke(workspaceId, project._id.toString(), result.worktree);
      publishRealtimeEvent(workspaceId, {
        type: "app-v2.commit.created",
        projectId: project._id.toString(),
        worktreeId: result.worktree._id.toString(),
        sha: result.sha,
        ...getAppV2ProjectEventAudience(project),
      });
      return c.json({
        success: true,
        sha: result.sha,
        worktree: worktreeJson(result.worktree),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/commits",
    tags: ["Apps v2"],
    summary: "List Apps v2 Git commits",
    security: AUTH_SECURITY,
    request: { params: ProjectParams, query: CommitListQuery },
    responses: okResponse(
      AppV2CommitListResponseSchema,
      "Apps v2 Git commit history",
    ),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId } = c.req.valid("param");
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      const commits = await services().worktrees.listCommits(
        project,
        c.req.valid("query").limit,
      );
      return c.json({ success: true, commits });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

routes.openapi(
  createRoute({
    method: "get",
    path: "/{projectId}/commits/{sha}",
    tags: ["Apps v2"],
    summary: "Get Apps v2 Git commit metadata",
    security: AUTH_SECURITY,
    request: { params: CommitParams },
    responses: okResponse(
      AppV2CommitDetailResponseSchema,
      "Apps v2 Git commit metadata",
    ),
  }),
  async c => {
    try {
      const requestActor = actor(c);
      const { workspaceId, projectId, sha } = c.req.valid("param");
      const project = await services().projects.getReadable(
        workspaceId,
        projectId,
        requestActor,
      );
      const commit = await services().worktrees.getCommit(project, sha);
      return c.json({ success: true, commit });
    } catch (error) {
      return errorResponse(c, error);
    }
  },
);

export const appsV2Routes = routes;
