/**
 * Processes — `/api/workspaces/:workspaceId/processes`.
 *
 * Durable agentic business processes (see api/src/processes/README.md):
 * the process list, runs and their timelines, the human-request inbox, and
 * business events. Authenticated + workspace-scoped. Members can view; members
 * (not viewers) can start, cancel and retry runs and emit events; workspace
 * admins enable processes and bind connections; who may answer an approval or
 * task is decided per request (assignees, else admins).
 *
 * API keys act as the user who created them, so "trigger by API call" is
 * `POST /{processId}/runs` or `POST /events` with a workspace key.
 *
 * Handlers return plain Responses under OPEN_RESPONSES (like favourites): the
 * service decides statuses through ProcessServiceError.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
} from "../openapi/core";
import { workspaceService } from "../services/workspace.service";
import { ensureProcessRuntime } from "../processes";
import {
  ProcessServiceError,
  cancelRun,
  countPendingHumanRequests,
  emitProcessEvent,
  getArtifact,
  getProcessDetail,
  getRunDetail,
  listHumanRequests,
  listProcesses,
  listRuns,
  respondToHumanRequest,
  retryRun,
  startRun,
  updateInstallation,
} from "../processes/service";
import { RUN_STATUSES } from "../processes/runtime/models";

const logger = loggers.api("processes");

export const processRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const ProcessParam = WorkspaceParam.extend({
  processId: z.string().openapi({ param: { name: "processId", in: "path" } }),
});
const RunParam = WorkspaceParam.extend({
  runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
});
const RequestParam = WorkspaceParam.extend({
  requestId: z.string().openapi({ param: { name: "requestId", in: "path" } }),
});
const ArtifactParam = RunParam.extend({
  eventId: z.string().openapi({ param: { name: "eventId", in: "path" } }),
});

processRoutes.use("*", unifiedAuthMiddleware);

processRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Invalid workspace ID format" },
      400,
    );
  }
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  const keyWorkspace = c.get("workspaceId" as never) as string | undefined;
  if (keyWorkspace && keyWorkspace !== workspaceId) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  }
  const member = await workspaceService.getMember(workspaceId, user.id);
  if (!member) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  } else {
    c.set("memberRole" as never, member.role as never);
  }
  ensureProcessRuntime();
  await next();
});

function scope(c: AuthenticatedContext) {
  const user = c.get("user") as { id: string; email: string };
  return {
    workspaceId: c.req.param("workspaceId") as string,
    user,
    role: c.get("memberRole" as never) as unknown as string,
  };
}

function requireRole(
  c: AuthenticatedContext,
  roles: string[],
): Response | null {
  if (!roles.includes(scope(c).role)) {
    return c.json({ success: false, error: "Insufficient permissions" }, 403);
  }
  return null;
}

const CAN_OPERATE = ["owner", "admin", "member"];
const CAN_CONFIGURE = ["owner", "admin"];

async function handle(
  c: AuthenticatedContext,
  work: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  try {
    return c.json({ success: true, ...(await work()) }, 200);
  } catch (error) {
    if (error instanceof ProcessServiceError) {
      return c.json({ success: false, error: error.message }, error.status);
    }
    logger.error("Processes route error", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal error",
      },
      500,
    );
  }
}

// ── list + inbox + runs + events (static paths before /{processId}) ────────

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Processes"],
    summary: "List processes with run stats and the pending-request count",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => {
      const { workspaceId } = scope(c);
      return {
        processes: await listProcesses(workspaceId),
        pendingRequests: await countPendingHumanRequests(workspaceId),
      };
    }),
);

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/inbox",
    tags: ["Processes"],
    summary: "Approvals and tasks across all processes",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({ status: z.enum(["pending", "decided"]).optional() }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => ({
      requests: await listHumanRequests(scope(c).workspaceId, {
        status: c.req.valid("query").status,
      }),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "post",
    path: "/inbox/{requestId}/respond",
    tags: ["Processes"],
    summary: "Approve/reject an approval, or submit a task",
    security: AUTH_SECURITY,
    request: {
      params: RequestParam,
      body: jsonBody(
        z.object({
          decision: z.enum(["approve", "reject", "submit"]),
          data: z.unknown().optional(),
          comment: z.string().max(4000).optional(),
        }),
      ),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => {
      const { workspaceId, user } = scope(c);
      const { requestId } = c.req.valid("param");
      return {
        request: await respondToHumanRequest(
          workspaceId,
          requestId,
          user,
          c.req.valid("json"),
        ),
      };
    }),
);

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/runs",
    tags: ["Processes"],
    summary: "List runs (optionally by process / status)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        processId: z.string().optional(),
        status: z.enum(RUN_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => ({
      runs: await listRuns(scope(c).workspaceId, c.req.valid("query")),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/runs/{runId}",
    tags: ["Processes"],
    summary: "A run with its step timeline, journal and human requests",
    security: AUTH_SECURITY,
    request: { params: RunParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () =>
      getRunDetail(scope(c).workspaceId, c.req.valid("param").runId),
    ),
);

processRoutes.openapi(
  createRoute({
    method: "post",
    path: "/runs/{runId}/cancel",
    tags: ["Processes"],
    summary: "Cancel a run",
    security: AUTH_SECURITY,
    request: { params: RunParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    requireRole(c, CAN_OPERATE) ??
    handle(c, async () => ({
      run: await cancelRun(
        scope(c).workspaceId,
        c.req.valid("param").runId,
        scope(c).user.id,
      ),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "post",
    path: "/runs/{runId}/retry",
    tags: ["Processes"],
    summary: "Retry a failed run from the step that failed",
    security: AUTH_SECURITY,
    request: { params: RunParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    requireRole(c, CAN_OPERATE) ??
    handle(c, async () => ({
      run: await retryRun(
        scope(c).workspaceId,
        c.req.valid("param").runId,
        scope(c).user.id,
      ),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/runs/{runId}/artifacts/{eventId}",
    tags: ["Processes"],
    summary: "Read an artifact produced by a run",
    security: AUTH_SECURITY,
    request: { params: ArtifactParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => {
      const { runId, eventId } = c.req.valid("param");
      return {
        artifact: await getArtifact(scope(c).workspaceId, runId, eventId),
      };
    }),
);

processRoutes.openapi(
  createRoute({
    method: "post",
    path: "/events",
    tags: ["Processes"],
    summary:
      "Emit a business event (starts triggered processes, wakes waiting runs)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: jsonBody(
        z.object({
          name: z.string().min(1).max(200),
          data: z.record(z.string(), z.unknown()).default({}),
          idempotencyKey: z.string().max(200).optional(),
        }),
      ),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    requireRole(c, CAN_OPERATE) ??
    handle(c, async () => {
      const { name, data, idempotencyKey } = c.req.valid("json");
      return emitProcessEvent(scope(c).workspaceId, name, data, {
        idempotencyKey,
        by: scope(c).user.id,
      });
    }),
);

// ── one process ────────────────────────────────────────────────────────────

processRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{processId}",
    tags: ["Processes"],
    summary: "A process: manifest, outline, versions, installation",
    security: AUTH_SECURITY,
    request: { params: ProcessParam },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    handle(c, async () => ({
      process: await getProcessDetail(
        scope(c).workspaceId,
        c.req.valid("param").processId,
      ),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{processId}",
    tags: ["Processes"],
    summary: "Enable/disable a process or bind its connection slots (admin)",
    security: AUTH_SECURITY,
    request: {
      params: ProcessParam,
      body: jsonBody(
        z.object({
          enabled: z.boolean().optional(),
          bindings: z.record(z.string(), z.string()).optional(),
        }),
      ),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    requireRole(c, CAN_CONFIGURE) ??
    handle(c, async () => ({
      process: await updateInstallation(
        scope(c).workspaceId,
        c.req.valid("param").processId,
        c.req.valid("json"),
        scope(c).user.id,
      ),
    })),
);

processRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{processId}/runs",
    tags: ["Processes"],
    summary: "Start a run (manual / API trigger)",
    security: AUTH_SECURITY,
    request: {
      params: ProcessParam,
      body: jsonBody(
        z.object({
          input: z.unknown().optional(),
          idempotencyKey: z.string().max(200).optional(),
        }),
      ),
    },
    responses: OPEN_RESPONSES,
  }),
  async c =>
    requireRole(c, CAN_OPERATE) ??
    handle(c, async () => {
      const { workspaceId, user } = scope(c);
      const body = c.req.valid("json");
      const authType = c.get("authType" as never) as unknown as
        | string
        | undefined;
      return startRun({
        workspaceId,
        processId: c.req.valid("param").processId,
        input: body.input ?? {},
        trigger: {
          type: authType === "session" ? "manual" : "api",
          by: user.id,
        },
        idempotencyKey: body.idempotencyKey,
      });
    }),
);
