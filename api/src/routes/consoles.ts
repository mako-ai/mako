import { createRoute, z } from "@hono/zod-openapi";
import { workspaceResourceLoader } from "./lib/load-resource";
import type { Context } from "hono";
import { ConsoleManager } from "../utils/console-manager";
import { canWriteResource } from "../utils/resource-acl";
import { wouldCreateFolderCycle } from "../utils/folder-tree";
import { registerFolderRoutes, type FolderBackend } from "./lib/folder-routes";
import {
  unifiedAuthMiddleware,
  isApiKeyAuth,
} from "../auth/unified-auth.middleware";
import { restQueryAccessFromStoredScopes } from "../auth/api-key-scopes";
import {
  DatabaseConnection,
  SavedConsole,
  ConsoleFolder,
  IDatabaseConnection,
  type ISavedConsole,
  ScheduledQueryRun,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { workspaceService } from "../services/workspace.service";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  queryExecutionService,
  QueryLanguage,
  QueryStatus,
} from "../services/query-execution.service";
import { queryExecutionSourceLabel } from "../services/query-execution-source";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { generateVersionComment } from "../services/version-comment.service";
import {
  applySqlRowLimit,
  checkPreviewQuerySafety,
} from "../services/query-pagination.service";
import { createStreamingExportResponse } from "../utils/query-export-stream";
import { inngest } from "../inngest";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import {
  getNextScheduledConsoleRunAt,
  validateScheduledConsoleSchedule,
} from "../services/scheduled-query-schedule.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { buildConsoleWriteGuard } from "../services/console-save-guards";
import { RepoRequiredError } from "../apps/config";
import {
  commitConsoleState,
  consoleCommitChanges,
  savedConsoleStateFromRepo,
  consoleFileVersions,
  consoleHistory,
  projectSavedConsole,
  requestConsoleDescription,
  restoreConsoleTo,
} from "../apps/workspace-consoles.service";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
} from "./lib/collaborator-routes";

/**
 * Map console language to query language for tracking
 */
function mapConsoleLanguageToQueryLanguage(
  language: "sql" | "javascript" | "mongodb",
): QueryLanguage {
  if (language === "mongodb") return "mongodb";
  if (language === "javascript") return "javascript";
  return "sql";
}

const logger = loggers.api("consoles");

/** The production gate (apps.md §17): no connected repo, no save. */
function repoRequired(c: Context, error: RepoRequiredError) {
  return c.json(
    { success: false, code: error.code, error: error.message },
    error.status as 412,
  );
}

/** GET/list without a GitHub binding is an empty explorer, not 412. */
function emptyConsoleTree() {
  return {
    success: true as const,
    myConsoles: [] as never[],
    sharedWithWorkspace: [] as never[],
    tree: [] as never[],
  };
}

async function connectionSummary(
  connectionId: unknown,
  workspaceId: string,
): Promise<{ id: unknown; name: unknown; type: unknown } | null> {
  if (!connectionId) return null;
  const id =
    typeof connectionId === "object" &&
    connectionId !== null &&
    "_id" in connectionId
      ? (connectionId as { _id: Types.ObjectId })._id
      : connectionId;
  if (!Types.ObjectId.isValid(String(id))) return null;
  const populated =
    typeof connectionId === "object" &&
    connectionId !== null &&
    "name" in connectionId
      ? (connectionId as { _id: Types.ObjectId; name?: string; type?: string })
      : null;
  if (populated?.name) {
    return { id: populated._id, name: populated.name, type: populated.type };
  }
  const doc = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(String(id)),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("name type")
    .lean();
  if (!doc) return null;
  return { id: doc._id, name: doc.name, type: doc.type };
}

// IMPORTANT: this MUST stay byte-for-byte compatible with the client hash so
// the server-computed baseline equals what the client would compute for the
// same snapshot. Mirror of `hashContent` in `app/src/utils/hash.ts` and
// `computeConsoleStateHash` in `app/src/utils/stateHash.ts`. The two packages
// can't share code (no common import path), so any change to the algorithm
// here must be made in lockstep with those files or Save will misdetect dirt.
function hashContent(content: string): string {
  let hash = 0;
  if (content.length === 0) return "0";

  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  return Math.abs(hash).toString(16);
}

function computeConsoleStateHash(
  content: string,
  connectionId?: string,
  databaseId?: string,
  databaseName?: string,
): string {
  return hashContent(
    `${content}|${connectionId || ""}|${databaseId || ""}|${databaseName || ""}`,
  );
}

/**
 * Hash of the last explicitly saved state — read from the console's file at
 * HEAD (git is the history; snapshot rows are no longer written).
 */
async function getLatestConsoleSavedStateHash(
  row: Pick<ISavedConsole, "workspaceId" | "path">,
): Promise<string | undefined> {
  const saved = await savedConsoleStateFromRepo(row);
  if (!saved) return undefined;
  return computeConsoleStateHash(
    saved.code,
    saved.connectionId,
    saved.databaseId,
    saved.databaseName,
  );
}

function sanitizeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export const consoleRoutes = createRouter();
const consoleManager = new ConsoleManager();

// Apply unified auth middleware to all console routes
consoleRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
consoleRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId") as string;
  if (workspaceId) {
    // Validate ObjectId format early to return 400 instead of 500
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
      c.set("memberRole", "admin");
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (!member) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
      c.set("memberRole", member.role);
    } else {
      // Neither API key nor session auth succeeded - reject request
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

consoleRoutes.use("/:id/schedule", requireWorkspaceAdmin);
consoleRoutes.use("/:id/schedule/*", requireWorkspaceAdmin);

// ── Sharing (collaborators + general access) ──
const loadConsoleById = workspaceResourceLoader(SavedConsole);

registerCollaboratorRoutes(consoleRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});
registerSharingSettingsRoutes(consoleRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});

// GET /api/workspaces/:workspaceId/consoles - List all consoles (tree structure) for workspace
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Consoles"],
    summary: "GET /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Access was verified by the router middleware; only the id is needed.
      const access = { workspaceId: c.req.param("workspaceId") as string };

      const user = c.get("user");
      const userId: string | undefined = user?.id;

      if (userId) {
        const member = await workspaceService.getMember(
          access.workspaceId,
          userId,
        );
        const userRole = member?.role || "member";

        const { myConsoles, sharedWithWorkspace } =
          await consoleManager.listConsolesSplit(
            access.workspaceId,
            userId,
            userRole,
          );

        return c.json({
          success: true,
          myConsoles,
          sharedWithWorkspace,
          tree: myConsoles,
        });
      }

      const tree = await consoleManager.listConsoles(
        access.workspaceId,
        userId,
      );
      return c.json({ success: true, tree });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json(emptyConsoleTree(), 200);
      }
      logger.error("Error listing consoles", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/content - Get specific console content
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/content",
    tags: ["Consoles"],
    summary: "GET /content",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      query: z.object({
        id: z
          .string()
          .optional()
          .openapi({ param: { name: "id", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.query("id");
      const user = c.get("user");

      // Verify user has access to workspace
      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      if (!consoleId) {
        return c.json(
          { success: false, error: "ID query parameter is required" },
          400,
        );
      }

      const consoleData = await consoleManager.getConsoleWithMetadata(
        consoleId,
        workspaceId,
      );

      if (!consoleData) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const fullConsole = consoleData._raw;

      if (
        fullConsole &&
        !(await consoleManager.canReadWithInheritance(fullConsole, user.id))
      ) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const consoleAccess = consoleData.access || "private";
      const ownerId = consoleData.owner_id;

      const member = await workspaceService.getMember(workspaceId, user.id);
      const isAdmin = member?.role === "owner" || member?.role === "admin";

      const readOnly = fullConsole
        ? !ConsoleManager.canWrite(fullConsole, user.id, isAdmin, member?.role)
        : false;

      // Resolve owner display name
      let ownerDisplayName: string | undefined;
      if (ownerId) {
        const ownerUser = await User.findById(ownerId).select("email").lean();
        ownerDisplayName = ownerUser?.email;
      }

      const savedStateHash =
        fullConsole && (consoleData.isSaved ?? true)
          ? await getLatestConsoleSavedStateHash(fullConsole)
          : undefined;

      return c.json({
        success: true,
        content: consoleData.content,
        connectionId: consoleData.connectionId,
        databaseName: consoleData.databaseName,
        databaseId: consoleData.databaseId,
        language: consoleData.language,
        id: consoleData.id,
        name: consoleData.name,
        path: consoleData.path,
        isSaved: consoleData.isSaved,
        savedStateHash,
        lastDraftOrigin: fullConsole?.lastDraftOrigin,
        chartSpec: consoleData.chartSpec,
        resultsViewMode: consoleData.resultsViewMode,
        access: consoleAccess,
        workspaceRole: fullConsole?.workspaceRole ?? "viewer",
        sharedWith: fullConsole?.sharedWith ?? [],
        owner_id: ownerId,
        ownerDisplayName,
        readOnly,
        schedule: fullConsole?.schedule,
        scheduledRun: fullConsole?.scheduledRun,
        // Optimistic-concurrency base: the client echoes this back as
        // expectedVersion on explicit saves.
        version: fullConsole?.version ?? 1,
        // Realtime sync base: clients compare against console.updated pokes
        // and echo it back as expectedDraftRevision on draft auto-saves.
        draftRevision: fullConsole?.draftRevision ?? 1,
        // Latest server-side run artifact (agent run_console while detached);
        // lets a reopened console render results without re-running.
        lastRun: fullConsole?.lastRun,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
      logger.error("Error fetching console content", {
        consoleId: c.req.query("id"),
        error,
      });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Console not found",
        },
        404,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/revisions-sync
//
// Bulk poke-then-pull reconciliation: the client sends the draftRevision of
// every console tab it has open; the server returns full payloads for the
// ones that changed. Called on realtime (re)connect and on tab focus, which
// makes reconnect a refetch rather than a replay.
consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/revisions-sync",
    tags: ["Consoles"],
    summary: "POST /revisions-sync",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const user = c.get("user");

      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      const body = await c.req.json();
      const revisions = body?.revisions as Record<string, unknown> | undefined;
      if (!revisions || typeof revisions !== "object") {
        return c.json(
          { success: false, error: "'revisions' object is required" },
          400,
        );
      }

      const entries = Object.entries(revisions)
        .filter(
          ([id, rev]) =>
            Types.ObjectId.isValid(id) &&
            typeof rev === "number" &&
            Number.isFinite(rev),
        )
        .slice(0, 100) as Array<[string, number]>;

      if (entries.length === 0) {
        return c.json({ success: true, changed: [], deleted: [] });
      }

      const docs = await SavedConsole.find({
        _id: { $in: entries.map(([id]) => new Types.ObjectId(id)) },
        workspaceId: new Types.ObjectId(workspaceId),
      });
      const docsById = new Map(docs.map(d => [d._id.toString(), d]));

      const changed: Array<Record<string, unknown>> = [];
      const deleted: string[] = [];
      for (const [id, clientRevision] of entries) {
        const doc = docsById.get(id);
        if (!doc || doc.is_deleted) {
          deleted.push(id);
          continue;
        }
        if (!(await consoleManager.canReadWithInheritance(doc, user.id))) {
          // Not readable (e.g. access flipped to private): treat as gone.
          deleted.push(id);
          continue;
        }
        const serverRevision = doc.draftRevision ?? 1;
        if (serverRevision === clientRevision) continue;
        const isSaved = doc.isSaved ?? true;
        const savedStateHash = isSaved
          ? await getLatestConsoleSavedStateHash(doc)
          : undefined;
        changed.push({
          id,
          draftRevision: serverRevision,
          name: doc.name,
          content: doc.code,
          connectionId: doc.connectionId?.toString(),
          databaseId: doc.databaseId,
          databaseName: doc.databaseName,
          version: doc.version ?? 1,
          // Server truth for draft-vs-saved: clients use this to keep the
          // tab's autosave eligibility correct (drafts autosave, saved
          // consoles don't). Missing on legacy docs ⇒ treated as saved.
          isSaved,
          savedStateHash,
          // Lets the client route an agent edit into the diff-review flow even
          // when the live poke was missed (reconnect/reload). Undefined ⇒ user.
          lastDraftOrigin: doc.lastDraftOrigin,
          lastRun: doc.lastRun,
        });
      }

      return c.json({ success: true, changed, deleted });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error syncing console revisions", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error syncing revisions",
        },
        500,
      );
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/schedule",
    tags: ["Consoles"],
    summary: "PUT /{id}/schedule",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const body = await c.req.json();

      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      });

      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const schedule = validateScheduledConsoleSchedule({
        cron: body?.cron,
        timezone: body?.timezone,
      });
      const nextAt = getNextScheduledConsoleRunAt(schedule);

      savedConsole.schedule = schedule;
      savedConsole.scheduledRun = {
        nextAt,
        lastAt: savedConsole.scheduledRun?.lastAt,
        lastStatus: savedConsole.scheduledRun?.lastStatus,
        lastError: savedConsole.scheduledRun?.lastError,
        lastDurationMs: savedConsole.scheduledRun?.lastDurationMs,
        lastRowsAffected: savedConsole.scheduledRun?.lastRowsAffected,
        lastRowCount: savedConsole.scheduledRun?.lastRowCount,
        runCount: savedConsole.scheduledRun?.runCount ?? 0,
        consecutiveFailures:
          savedConsole.scheduledRun?.consecutiveFailures ?? 0,
      };
      savedConsole.isSaved = true;
      // The schedule is authored: it lives in the file's front-matter.
      const committed = await commitConsoleState({
        row: savedConsole,
        previousPath: savedConsole.path,
        actorUserId: c.get("user")?.id,
        message: `schedule: ${savedConsole.name}`,
      });
      savedConsole.path = committed.path;
      savedConsole.sourceBlobSha = committed.sourceBlobSha;
      await savedConsole.save();

      return c.json({
        success: true,
        schedule: savedConsole.schedule,
        scheduledRun: savedConsole.scheduledRun,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error updating console schedule", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update console schedule",
        },
        500,
      );
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/schedule",
    tags: ["Consoles"],
    summary: "DELETE /{id}/schedule",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");

      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const current = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!current) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
      const unscheduledSet: Record<string, unknown> = {};
      if (current.isSaved) {
        current.schedule = undefined;
        const committed = await commitConsoleState({
          row: current,
          previousPath: current.path,
          actorUserId: c.get("user")?.id,
          message: `unschedule: ${current.name}`,
        });
        unscheduledSet.path = committed.path;
        unscheduledSet.sourceBlobSha = committed.sourceBlobSha;
      }
      await SavedConsole.updateOne(
        { _id: current._id },
        {
          ...(Object.keys(unscheduledSet).length
            ? { $set: unscheduledSet }
            : {}),
          $unset: {
            schedule: 1,
            "scheduledRun.nextAt": 1,
          },
        },
      );

      return c.json({ success: true });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error removing console schedule", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to remove console schedule",
        },
        500,
      );
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/schedule/run",
    tags: ["Consoles"],
    summary: "POST /{id}/schedule/run",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const user = c.get("user");

      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).select("_id");

      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const eventId = await inngest.send({
        name: "scheduled_query/execute",
        data: {
          workspaceId,
          consoleId,
          triggerType: "manual",
          triggeredBy: user?.id,
        },
      });

      return c.json({ success: true, eventId });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error triggering scheduled console run", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to trigger scheduled query run",
        },
        500,
      );
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/schedule/runs",
    tags: ["Consoles"],
    summary: "List scheduled query runs",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const workspaceObjectId = new Types.ObjectId(workspaceId);
      const consoleObjectId = new Types.ObjectId(consoleId);

      const [runs, consoleDoc] = await Promise.all([
        ScheduledQueryRun.find({
          workspaceId: workspaceObjectId,
          consoleId: consoleObjectId,
        })
          .sort({ triggeredAt: -1 })
          .limit(limit)
          .lean(),
        SavedConsole.findOne({
          _id: consoleObjectId,
          workspaceId: workspaceObjectId,
        })
          .select("scheduledRun")
          .lean(),
      ]);

      return c.json({
        success: true,
        scheduledRun: consoleDoc?.scheduledRun,
        runs: runs.map(run => ({
          id: run._id.toString(),
          triggeredAt: run.triggeredAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          status: run.status,
          triggerType: run.triggerType,
          triggeredBy: run.triggeredBy,
          durationMs: run.durationMs,
          rowsAffected: run.rowsAffected,
          rowCount: run.rowCount,
          error: run.error,
          inngestRunId: run.inngestRunId,
        })),
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error listing scheduled console runs", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to list scheduled query runs",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/search?q=...
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/search",
    tags: ["Consoles"],
    summary: "GET /search",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      query: z.object({
        q: z
          .string()
          .optional()
          .openapi({ param: { name: "q", in: "query" } }),
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const query = c.req.query("q") || "";
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

      if (query.length < 2) {
        return c.json({ results: [] });
      }

      const { searchConsoles } = await import(
        "../agent-lib/tools/console-search-tools"
      );
      const results = await searchConsoles(query, workspaceId, limit);

      return c.json({ results });
    } catch (err) {
      logger.error("Console search failed", { error: err });
      return c.json({ success: false, error: "Search failed" }, 500);
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles - Create new console
consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Consoles"],
    summary: "POST /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const body = await c.req.json();
      const {
        id, // Optional client-provided ID
        path: consolePath,
        content,
        connectionId,
        databaseId, // Backward compatibility
        databaseName,
        folderId,
        description,
        language,
        isPrivate,
        access,
      } = body;
      const user = c.get("user");

      // Verify user has access to workspace
      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      if (!consolePath || typeof consolePath !== "string") {
        return c.json(
          { success: false, error: "Path is required and must be a string" },
          400,
        );
      }
      if (typeof content !== "string") {
        return c.json(
          { success: false, error: "Content must be a string" },
          400,
        );
      }

      // connectionId is optional - consoles can be saved without being associated with a specific database
      let targetConnectionId = connectionId;
      if (!targetConnectionId) {
        // Try to get the first database for the workspace, but don't require it
        const databases = await DatabaseConnection.find({ workspaceId }).limit(
          1,
        );
        if (databases.length > 0) {
          targetConnectionId = databases[0]._id.toString();
        }
        // If no databases exist, that's fine - targetConnectionId will remain undefined
      }

      // Check if a console already exists at this path (with a different ID)
      const existingConsole = await consoleManager.getConsoleByPath(
        consolePath,
        workspaceId,
      );

      // If console exists and has a different ID, check for conflict
      // Skip conflict if existing console only has placeholder content (loading...)
      const hasRealContent =
        existingConsole?.code &&
        existingConsole.code.trim() !== "" &&
        existingConsole.code !== "loading...";

      // Determine which ID to use for saving
      let consoleIdToUse = id;

      if (existingConsole && existingConsole._id.toString() !== id) {
        if (hasRealContent) {
          // Real conflict - return conflict response for user to resolve
          return c.json(
            {
              success: false,
              error: "conflict",
              conflict: {
                existingId: existingConsole._id.toString(),
                existingContent: existingConsole.code,
                existingName: existingConsole.name,
                existingLanguage: existingConsole.language,
                path: consolePath,
              },
            },
            409,
          );
        } else {
          // Existing console has placeholder content - overwrite it by using its ID
          // This prevents creating a duplicate at the same path
          // IMPORTANT: The client uses the returned `id` in the response to update its
          // local state, so we must return savedConsole._id (not the original client ID)
          consoleIdToUse = existingConsole._id.toString();
        }
      }

      const savedConsole = await consoleManager.saveConsole(
        consolePath,
        content,
        workspaceId,
        user.id,
        targetConnectionId,
        databaseName,
        databaseId,
        {
          id: consoleIdToUse, // Use existing console ID if overwriting placeholder, otherwise client ID
          folderId,
          description,
          language,
          isPrivate,
          access,
        },
      );

      // Persist chart spec and view mode if provided (authored: they ride
      // along in the file, so the commit is re-projected with them).
      if (body.chartSpec !== undefined || body.resultsViewMode !== undefined) {
        const chartUpdate: Record<string, unknown> = {};
        if (body.chartSpec !== undefined) {
          chartUpdate.chartSpec = body.chartSpec;
          savedConsole.chartSpec = body.chartSpec;
        }
        if (body.resultsViewMode !== undefined) {
          chartUpdate.resultsViewMode = body.resultsViewMode;
          savedConsole.resultsViewMode = body.resultsViewMode;
        }
        const committed = await commitConsoleState({
          row: savedConsole,
          previousPath: savedConsole.path,
          actorUserId: user.id,
          message: `save: ${consolePath}`,
        });
        chartUpdate.path = committed.path;
        chartUpdate.sourceBlobSha = committed.sourceBlobSha;
        await SavedConsole.findByIdAndUpdate(savedConsole._id, {
          $set: chartUpdate,
        });
      }

      // Create version 1 for this new console
      const freshDoc = await SavedConsole.findById(savedConsole._id).lean();
      if (freshDoc) {
        await SavedConsole.updateOne(
          { _id: savedConsole._id },
          { $set: { version: 1 } },
        );
      }

      // Description + embedding are derived from the committed content,
      // debounced and sha-guarded (apps.md §16.4).
      requestConsoleDescription({
        workspaceId,
        consoleId: savedConsole._id.toString(),
        tracking: { userId: user.id, userEmail: user.email },
      });

      return c.json(
        {
          success: true,
          message: "Console created successfully",
          data: {
            id: savedConsole._id.toString(),
            path: consolePath,
            content,
            connectionId: targetConnectionId,
            databaseName,
            databaseId,
            language: savedConsole.language,
          },
        },
        201,
      );
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error creating console", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error creating console",
        },
        500,
      );
    }
  },
);

// PUT /api/workspaces/:workspaceId/consoles/:pathOrId - Update/upsert console
// If pathOrId is a valid ObjectId, upserts by ID (used for auto-save)
// Otherwise, saves by path (used for explicit user save to folder)
consoleRoutes.put("/:path{.+}", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const pathOrId = c.req.param("path");
    const body = await c.req.json();
    const user = c.get("user");

    // Verify user has access to workspace
    // Workspace access itself is the router middleware's job (it ran and
    // set memberRole); this only keeps the route session-only.
    if (!user) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (typeof body.content !== "string") {
      return c.json(
        { success: false, error: "Content is required and must be a string" },
        400,
      );
    }

    const memberPut = await workspaceService.getMember(workspaceId, user.id);
    const isAdminPut =
      memberPut?.role === "owner" || memberPut?.role === "admin";

    // Check if pathOrId is a valid ObjectId - if so, do ID-based update
    if (Types.ObjectId.isValid(pathOrId) && pathOrId.length === 24) {
      const existingById = await SavedConsole.findOne({
        _id: new Types.ObjectId(pathOrId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (
        existingById &&
        !ConsoleManager.canWrite(
          existingById,
          user.id,
          isAdminPut,
          memberPut?.role,
        )
      ) {
        return c.json(
          {
            success: false,
            error: "This console is read-only. Create a copy to make changes.",
          },
          403,
        );
      }

      const now = new Date();
      const isExplicitSave = body.isSaved === true;

      // Optimistic concurrency (opt-in): when the client sends the version it
      // loaded, explicit saves only apply while the document still has that
      // version. On mismatch we return 409 version_conflict with the server
      // copy so the user can resolve, instead of silently overwriting another
      // user's save (previously last-write-wins).
      const expectedVersion =
        typeof body.expectedVersion === "number" &&
        Number.isInteger(body.expectedVersion) &&
        body.expectedVersion >= 1
          ? (body.expectedVersion as number)
          : undefined;
      // Realtime sync (issue #475): `clientId` identifies the writing tab
      // (or `agent:<chatId>`) so subscribers can suppress their own echoes;
      // `expectedDraftRevision` makes draft auto-saves revision-checked so a
      // stale tab cannot silently overwrite a newer draft.
      const clientId =
        typeof body.clientId === "string"
          ? body.clientId.slice(0, 64)
          : undefined;
      const expectedDraftRevision =
        typeof body.expectedDraftRevision === "number" &&
        Number.isInteger(body.expectedDraftRevision) &&
        body.expectedDraftRevision >= 1
          ? (body.expectedDraftRevision as number)
          : undefined;
      const publishConsoleUpdated = (
        doc: ISavedConsole,
        origin: "draft" | "save",
      ) => {
        publishRealtimeEvent(workspaceId, {
          type: "console.updated",
          consoleId: doc._id.toString(),
          draftRevision: doc.draftRevision ?? 1,
          name: doc.name,
          updatedBy: user.id,
          clientId,
          origin,
        });
      };

      const idFilter = {
        _id: new Types.ObjectId(pathOrId),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      // Explicit saves are guarded on BOTH counters when the client sent
      // them: `version` catches concurrent explicit saves, `draftRevision`
      // catches everything else that moves the draft (agent modify_console,
      // another tab's autosave) — without it a stale window's Cmd+S passes
      // the version guard and silently reverts those edits. See
      // console-save-guards.ts for the atomic-filter / no-upsert semantics.
      const { filter: guardedFilter, guardActive: saveGuardActive } =
        buildConsoleWriteGuard({
          baseFilter: idFilter,
          docExists: existingById !== null,
          expectedVersion,
          expectedDraftRevision,
        });
      const versionConflictResponse = async () => {
        const current = await SavedConsole.findOne(idFilter);
        return c.json(
          {
            success: false,
            error: "version_conflict",
            versionConflict: {
              currentVersion: current?.version ?? 1,
              // Both bases are needed to retry an "Overwrite with mine":
              // the retried save must pass BOTH guards.
              currentDraftRevision: current?.draftRevision ?? 1,
              content: current?.code ?? "",
              name: current?.name,
              updatedAt: current?.updatedAt,
            },
          },
          409,
        );
      };

      // If this is an explicit save with a path, check for path conflicts
      if (isExplicitSave && body.path) {
        const consolePath = body.path;
        const existingConsole = await consoleManager.getConsoleByPath(
          consolePath,
          workspaceId,
        );

        // If a different console exists at this path, return conflict
        if (existingConsole && existingConsole._id.toString() !== pathOrId) {
          return c.json(
            {
              success: false,
              error: "conflict",
              conflict: {
                existingId: existingConsole._id.toString(),
                existingContent: existingConsole.code,
                existingName: existingConsole.name,
                existingLanguage: existingConsole.language,
                path: consolePath,
              },
            },
            409,
          );
        }

        // Parse path to get folder and name
        const parts = consolePath.split("/");
        const consoleName = parts[parts.length - 1];
        let folderId: string | undefined;
        if (parts.length > 1) {
          const folderPath = parts.slice(0, -1);
          folderId = await consoleManager.findOrCreateFolderPath(
            folderPath,
            workspaceId,
            user.id,
          );
        }

        // Update with path information (use upsert in case console hasn't been auto-saved yet)
        const setFields: Record<string, any> = {
          code: body.content,
          name: consoleName,
          folderId: folderId ? new Types.ObjectId(folderId) : undefined,
          connectionId: body.connectionId
            ? new Types.ObjectId(body.connectionId)
            : undefined,
          databaseName: body.databaseName,
          databaseId: body.databaseId,
          isSaved: true,
          updatedAt: now,
          // User-initiated write: clears any prior agent origin so a later
          // reconnect doesn't re-surface this as an agent diff.
          lastDraftOrigin: "user",
        };
        if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
        if (body.resultsViewMode !== undefined) {
          setFields.resultsViewMode = body.resultsViewMode;
        }
        if (body.access !== undefined) {
          setFields.access = body.access;
          setFields.isPrivate = body.access === "private";
        }

        const setOnInsertFields: Record<string, any> = {
          createdBy: user.id,
          owner_id: user.id,
          language: "sql" as const,
          executionCount: 0,
          createdAt: now,
        };
        if (body.access === undefined) {
          setOnInsertFields.isPrivate = true;
          setOnInsertFields.access = "private" as const;
        }

        // Git first (apps.md §16.3), then the guarded row write; a lost
        // guard reverts the commit.
        const projected = await projectSavedConsole({
          workspaceId,
          current: existingById ?? null,
          set: setFields,
          onInsert: setOnInsertFields,
          actorUserId: user.id,
          message: body.comment?.trim() || `save: ${consolePath}`,
        });
        setFields.path = projected.path;
        setFields.sourceBlobSha = projected.sourceBlobSha;

        const result = await SavedConsole.findOneAndUpdate(
          guardedFilter,
          {
            $set: setFields,
            $inc: { version: 1, draftRevision: 1 },
            $setOnInsert: setOnInsertFields,
          },
          { upsert: !saveGuardActive, new: true },
        );
        if (!result) {
          await projected.revert();
          return versionConflictResponse();
        }

        publishConsoleUpdated(result as ISavedConsole, "save");
        requestConsoleDescription({
          workspaceId,
          consoleId: result._id.toString(),
          tracking: { userId: user.id, userEmail: user.email },
        });

        return c.json({
          success: true,
          message: "Console saved",
          version: result.version,
          draftRevision: result.draftRevision ?? 1,
          console: {
            id: result._id.toString(),
            name: result.name,
          },
        });
      }

      // Build $set object - only include name if title is explicitly provided
      const setFields: Record<string, any> = {
        code: body.content,
        connectionId: body.connectionId
          ? new Types.ObjectId(body.connectionId)
          : undefined,
        databaseName: body.databaseName,
        databaseId: body.databaseId,
        updatedAt: now,
        // User-initiated write (autosave / explicit save / agent-edit revert):
        // clears any prior agent origin so reconnect won't re-surface a diff.
        lastDraftOrigin: "user",
      };

      // Only update name if explicitly provided
      if (body.title !== undefined) {
        setFields.name = body.title || "Untitled";
      }

      if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
      if (body.resultsViewMode !== undefined) {
        setFields.resultsViewMode = body.resultsViewMode;
      }
      if (body.access !== undefined) {
        setFields.access = body.access;
        setFields.isPrivate = body.access === "private";
      }

      // If this is an explicit save without path (e.g., Cmd+S on already saved), mark as saved
      if (isExplicitSave) {
        setFields.isSaved = true;
      }

      if (isExplicitSave) {
        const setOnInsertFields: Record<string, any> = {
          createdBy: user.id,
          owner_id: user.id,
          language: "sql" as const,
          executionCount: 0,
          createdAt: now,
        };
        if (body.access === undefined) {
          setOnInsertFields.isPrivate = true;
          setOnInsertFields.access = "private" as const;
        }
        // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
        if (!setFields.name) {
          setOnInsertFields.name = body.title || "Untitled";
        }

        const projected = await projectSavedConsole({
          workspaceId,
          current: existingById ?? null,
          set: setFields,
          onInsert: setOnInsertFields,
          actorUserId: user.id,
          message:
            body.comment?.trim() ||
            `save: ${setFields.name ?? existingById?.name ?? "console"}`,
        });
        setFields.path = projected.path;
        setFields.sourceBlobSha = projected.sourceBlobSha;

        const result = await SavedConsole.findOneAndUpdate(
          guardedFilter,
          {
            $set: setFields,
            $inc: { version: 1, draftRevision: 1 },
            $setOnInsert: setOnInsertFields,
          },
          { upsert: !saveGuardActive, new: true },
        );
        if (!result) {
          await projected.revert();
          return versionConflictResponse();
        }

        publishConsoleUpdated(result as ISavedConsole, "save");

        requestConsoleDescription({
          workspaceId,
          consoleId: result._id.toString(),
          tracking: { userId: user.id, userEmail: user.email },
        });

        return c.json({
          success: true,
          message: "Console saved",
          version: result.version,
          draftRevision: result.draftRevision ?? 1,
          console: {
            id: result._id.toString(),
            name: result.name,
          },
        });
      }

      // Draft auto-save flow: Use upsert to create if doesn't exist.
      //
      // Not `version`-guarded (that counter belongs to explicit saves), but
      // when the client sends `expectedDraftRevision` the write is
      // draft-revision-checked: a stale tab gets 409 draft_conflict instead
      // of overwriting a newer draft (another tab, another user, or the
      // agent). Clients without the field keep legacy last-write-wins.
      const setOnInsertFields: Record<string, any> = {
        createdBy: user.id,
        owner_id: user.id,
        language: "sql" as const,
        isPrivate: true,
        access: "private" as const,
        isSaved: false,
        executionCount: 0,
        createdAt: now,
      };
      // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
      if (!setFields.name) {
        setOnInsertFields.name = "Untitled";
      }

      const { filter: draftFilter, guardActive: useDraftGuard } =
        buildConsoleWriteGuard({
          baseFilter: idFilter,
          docExists: existingById !== null,
          // Draft autosaves are deliberately NOT version-guarded (that
          // counter belongs to explicit saves).
          expectedDraftRevision,
        });

      const result = await SavedConsole.findOneAndUpdate(
        draftFilter,
        {
          $set: setFields,
          $inc: { draftRevision: 1 },
          $setOnInsert: setOnInsertFields,
        },
        { upsert: !useDraftGuard, new: true },
      );

      if (!result) {
        const current = await SavedConsole.findOne(idFilter);
        return c.json(
          {
            success: false,
            error: "draft_conflict",
            draftConflict: {
              currentDraftRevision: current?.draftRevision ?? 1,
              content: current?.code ?? "",
              name: current?.name,
              updatedAt: current?.updatedAt,
            },
          },
          409,
        );
      }

      publishConsoleUpdated(result as ISavedConsole, "draft");

      return c.json({
        success: true,
        message: "Console saved",
        version: result.version,
        draftRevision: result.draftRevision ?? 1,
        console: {
          id: result._id.toString(),
          name: result.name,
        },
      });
    }

    // Path-based save (explicit user save to folder)
    const consolePath = pathOrId;

    // connectionId is optional - consoles can be saved without being associated with a specific database
    let targetConnectionId = body.connectionId;
    if (!targetConnectionId) {
      // Try to get the first database for the workspace, but don't require it
      const databases = await DatabaseConnection.find({ workspaceId }).limit(1);
      if (databases.length > 0) {
        targetConnectionId = databases[0]._id.toString();
      }
      // If no databases exist, that's fine - targetConnectionId will remain undefined
    }

    const savedConsole = await consoleManager.saveConsole(
      consolePath,
      body.content,
      workspaceId,
      user.id,
      targetConnectionId,
      body.databaseName,
      body.databaseId,
      {
        folderId: body.folderId,
        description: body.description,
        language: body.language,
        isPrivate: body.isPrivate,
        access: body.access,
      },
    );

    // Create version 1 for this new console
    const freshDocPath = await SavedConsole.findById(savedConsole._id).lean();
    if (freshDocPath) {
      await SavedConsole.updateOne(
        { _id: savedConsole._id },
        { $set: { version: 1 } },
      );
    }

    requestConsoleDescription({
      workspaceId,
      consoleId: savedConsole._id.toString(),
      tracking: { userId: user.id, userEmail: user.email },
    });

    return c.json({
      success: true,
      message: "Console updated successfully",
      data: {
        id: savedConsole._id.toString(),
        path: consolePath,
        content: body.content,
        connectionId: targetConnectionId,
        databaseName: body.databaseName,
        databaseId: body.databaseId,
        language: savedConsole.language,
      },
    });
  } catch (error) {
    logger.error("Error updating console", {
      path: c.req.param("path"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error updating console",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/:id/rename - Rename a console
consoleRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/rename",
    tags: ["Consoles"],
    summary: "PATCH /{id}/rename",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const body = await c.req.json();
      const { name } = body;
      const user = c.get("user");

      // Verify user has access to workspace
      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      const memberRename = await workspaceService.getMember(
        workspaceId,
        user.id,
      );
      const isAdminRename =
        memberRename?.role === "owner" || memberRename?.role === "admin";

      if (Types.ObjectId.isValid(consoleId)) {
        const existing = await SavedConsole.findOne({
          _id: new Types.ObjectId(consoleId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (
          existing &&
          !ConsoleManager.canWrite(
            existing,
            user.id,
            isAdminRename,
            memberRename?.role,
          )
        ) {
          return c.json(
            {
              success: false,
              error: "Cannot rename a read-only console",
            },
            403,
          );
        }
      }

      if (!name || typeof name !== "string") {
        return c.json(
          { success: false, error: "Name is required and must be a string" },
          400,
        );
      }

      const success = await consoleManager.renameConsole(
        consoleId,
        name,
        workspaceId,
        user.id,
      );

      if (success) {
        // Bump the draft revision so revision-sync catches the rename, then
        // poke subscribers (other tabs/users update the tab title live).
        if (Types.ObjectId.isValid(consoleId)) {
          const renamed = await SavedConsole.findOneAndUpdate(
            {
              _id: new Types.ObjectId(consoleId),
              workspaceId: new Types.ObjectId(workspaceId),
            },
            { $inc: { draftRevision: 1 } },
            { new: true },
          );
          if (renamed) {
            publishRealtimeEvent(workspaceId, {
              type: "console.updated",
              consoleId,
              draftRevision: renamed.draftRevision ?? 1,
              name: renamed.name,
              updatedBy: user.id,
              origin: "save",
            });
          }
        }
        return c.json({
          success: true,
          message: "Console renamed successfully",
        });
      } else {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error renaming console", {
        consoleId: c.req.param("id"),
        error,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error renaming console",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/consoles/:id - Soft-delete a console
consoleRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Consoles"],
    summary: "DELETE /{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const user = c.get("user");

      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      if (Types.ObjectId.isValid(consoleId)) {
        const existing = await SavedConsole.findOne({
          _id: new Types.ObjectId(consoleId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (existing) {
          const ownerId = existing.owner_id || existing.createdBy;
          if (ownerId !== user.id) {
            const isAdminOrOwner = await workspaceService.hasRole(
              workspaceId,
              user.id,
              ["owner", "admin"],
            );
            if (!isAdminOrOwner) {
              return c.json(
                {
                  success: false,
                  error:
                    "Only the console owner or a workspace admin can delete it",
                },
                403,
              );
            }
          }
        }
      }

      const success = await consoleManager.softDeleteConsole(
        consoleId,
        workspaceId,
        user.id,
      );

      if (success) {
        publishRealtimeEvent(workspaceId, {
          type: "console.deleted",
          consoleId,
        });
        return c.json({
          success: true,
          message: "Console deleted successfully",
          id: consoleId,
        });
      } else {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error deleting console", {
        consoleId: c.req.param("id"),
        error,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error deleting console",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/:id/duplicate - Duplicate a console
consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/duplicate",
    tags: ["Consoles"],
    summary: "POST /{id}/duplicate",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const user = c.get("user");

      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      const copy = await consoleManager.duplicateConsole(
        consoleId,
        workspaceId,
        user.id,
      );

      if (copy) {
        return c.json(
          {
            success: true,
            message: "Console duplicated",
            data: {
              id: copy._id.toString(),
              name: copy.name,
              folderId: copy.folderId?.toString(),
            },
          },
          201,
        );
      } else {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error duplicating console", {
        consoleId: c.req.param("id"),
        error,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error duplicating console",
        },
        500,
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/consoles/:id/restore - Restore a soft-deleted console
consoleRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/restore",
    tags: ["Consoles"],
    summary: "PATCH /{id}/restore",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const user = c.get("user");

      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      const success = await consoleManager.restoreConsole(
        consoleId,
        workspaceId,
        user.id,
      );

      if (success) {
        return c.json({ success: true, message: "Console restored" });
      } else {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error restoring console", {
        consoleId: c.req.param("id"),
        error,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Unknown error restoring console",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/:id/version-comment - Generate AI version comment
consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/version-comment",
    tags: ["Consoles"],
    summary: "POST /{id}/version-comment",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const user = c.get("user");

      // Workspace access itself is the router middleware's job (it ran and
      // set memberRole); this only keeps the route session-only.
      if (!user) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }

      const body = await c.req.json();
      const { newContent, source, aiPrompt } = body;

      if (typeof newContent !== "string") {
        return c.json(
          { success: false, error: "newContent must be a string" },
          400,
        );
      }

      if (newContent.length > 50_000) {
        return c.json(
          { success: false, error: "Content too large for comment generation" },
          400,
        );
      }

      let previousContent = "";
      let versionFound = false;
      if (Types.ObjectId.isValid(consoleId)) {
        const row = await SavedConsole.findOne({
          _id: new Types.ObjectId(consoleId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).select("workspaceId path");
        const saved = row ? await savedConsoleStateFromRepo(row) : null;
        if (saved?.code) {
          previousContent = saved.code;
          versionFound = true;
        }
        logger.debug("Version comment baseline lookup", {
          consoleId,
          versionFound,
          previousContentLength: previousContent.length,
          newContentLength: newContent.length,
        });
      }

      const result = await generateVersionComment(
        {
          previousContent,
          newContent,
          language: "sql",
          source: source === "ai" ? "ai" : "user",
          aiPrompt: typeof aiPrompt === "string" ? aiPrompt : undefined,
        },
        { workspaceId, userId: user.id, userEmail: user.email },
      );

      return c.json({
        success: true,
        comment: result.comment,
        diff: result.diff,
        debug: {
          consoleId,
          versionFound,
          previousContentLength: previousContent.length,
          newContentLength: newContent.length,
        },
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error generating version comment", { error });
      return c.json(
        { success: false, error: "Failed to generate version comment" },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/:id/execute - Execute a saved console
consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/execute",
    tags: ["Consoles"],
    summary: "POST /{id}/execute",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const startTime = Date.now();
    let database: IDatabaseConnection | null = null;
    let executionStatus: QueryStatus = "error";
    let rowCount: number | undefined;
    let errorType: string | undefined;
    let workspaceId: string | undefined;
    let consoleIdParsed: Types.ObjectId | undefined;

    try {
      // Access was verified by the router middleware; only the id is needed.
      const access = { workspaceId: c.req.param("workspaceId") as string };
      workspaceId = access.workspaceId;

      const user = c.get("user");
      const apiKey = c.get("apiKey");
      const queryAccess = apiKey
        ? restQueryAccessFromStoredScopes(apiKey.scopes)
        : "write";
      if (queryAccess === "none") {
        return c.json(
          { success: false, error: "API key does not have query access" },
          403,
        );
      }
      const consoleId = c.req.param("id");
      const mode = c.req.query("mode");
      const pageSizeParam = c.req.query("pageSize");
      const cursorParam = c.req.query("cursor");

      // Validate console ID
      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }
      consoleIdParsed = new Types.ObjectId(consoleId);

      // Find the console
      const savedConsole = await SavedConsole.findOne({
        _id: consoleIdParsed,
        workspaceId: new Types.ObjectId(access.workspaceId),
      });

      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      if (
        user &&
        !(await consoleManager.canReadWithInheritance(savedConsole, user.id))
      ) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      // If console has a connection ID, verify it exists and belongs to workspace
      if (savedConsole.connectionId) {
        database = await DatabaseConnection.findOne({
          _id: savedConsole.connectionId,
          workspaceId: new Types.ObjectId(access.workspaceId),
        });

        if (!database) {
          return c.json(
            {
              success: false,
              error: "Associated database not found or access denied",
            },
            404,
          );
        }
      }

      // Execute the query based on language
      let result;
      if (!database) {
        return c.json(
          {
            success: false,
            error: "Console has no associated database connection",
          },
          400,
        );
      }

      // Pass explicit databaseId and databaseName for cluster mode (D1, etc.)
      const executionOptions = {
        databaseId: savedConsole.databaseId,
        databaseName: savedConsole.databaseName,
        readOnly: queryAccess === "read",
      };
      const isPreviewMode = mode === "preview";

      if (savedConsole.language === "mongodb") {
        if (
          savedConsole.mongoOptions &&
          savedConsole.mongoOptions.collection &&
          savedConsole.mongoOptions.operation
        ) {
          // For structured MongoDB operations (find, aggregate, etc.)
          const mongoQuery = {
            collection: savedConsole.mongoOptions.collection,
            operation: savedConsole.mongoOptions.operation,
            query: savedConsole.code,
          };

          result = isPreviewMode
            ? await databaseConnectionService.executePreviewQuery(
                database,
                mongoQuery,
                {
                  ...savedConsole.mongoOptions,
                  ...executionOptions,
                  pageSize: pageSizeParam
                    ? parseInt(pageSizeParam, 10)
                    : undefined,
                  cursor: cursorParam || null,
                },
              )
            : await databaseConnectionService.executeQuery(
                database,
                mongoQuery,
                {
                  ...savedConsole.mongoOptions,
                  ...executionOptions,
                },
              );
        } else {
          // For JavaScript-style MongoDB queries (db.collection.find(), etc.)
          result = isPreviewMode
            ? await databaseConnectionService.executePreviewQuery(
                database,
                savedConsole.code,
                {
                  ...executionOptions,
                  pageSize: pageSizeParam
                    ? parseInt(pageSizeParam, 10)
                    : undefined,
                  cursor: cursorParam || null,
                },
              )
            : await databaseConnectionService.executeQuery(
                database,
                savedConsole.code,
                executionOptions,
              );
        }
      } else {
        // For SQL and other languages, execute the code directly
        result = isPreviewMode
          ? await databaseConnectionService.executePreviewQuery(
              database,
              savedConsole.code,
              {
                ...executionOptions,
                pageSize: pageSizeParam
                  ? parseInt(pageSizeParam, 10)
                  : undefined,
                cursor: cursorParam || null,
              },
            )
          : await databaseConnectionService.executeQuery(
              database,
              savedConsole.code,
              executionOptions,
            );
      }

      // Update execution stats
      await SavedConsole.updateOne(
        { _id: savedConsole._id },
        {
          $set: { lastExecutedAt: new Date() },
          $inc: { executionCount: 1 },
        },
      );

      // API-key executes count as external use (monitor integrations separately
      // from in-app runs).
      if (apiKey) {
        void consoleManager.recordExternalUse(
          savedConsole._id.toString(),
          access.workspaceId,
          "api",
          "execute",
        );
      }

      // Return the result
      const previewRows =
        "rows" in result && Array.isArray(result.rows)
          ? result.rows
          : undefined;
      const data = "data" in result ? result.data || [] : [];
      rowCount =
        result.rowCount ||
        (Array.isArray(previewRows)
          ? previewRows.length
          : Array.isArray(data)
            ? data.length
            : 0);

      // Determine execution status
      if (result.success) {
        executionStatus = "success";
      } else {
        executionStatus = "error";
        const errorMsg = result.error?.toLowerCase() || "";
        if (errorMsg.includes("syntax")) {
          errorType = "syntax";
        } else if (
          errorMsg.includes("timeout") ||
          errorMsg.includes("timed out")
        ) {
          errorType = "timeout";
          executionStatus = "timeout";
        } else if (errorMsg.includes("cancel") || errorMsg.includes("abort")) {
          errorType = "cancelled";
          executionStatus = "cancelled";
        } else if (
          errorMsg.includes("connection") ||
          errorMsg.includes("connect")
        ) {
          errorType = "connection";
        } else if (
          errorMsg.includes("permission") ||
          errorMsg.includes("access denied")
        ) {
          errorType = "permission";
        } else {
          errorType = "unknown";
        }
      }

      // Track query execution (fire-and-forget)
      const userId = user?.id || apiKey?.createdBy;
      if (userId && database) {
        queryExecutionService.track({
          userId,
          apiKeyId: apiKey?._id,
          workspaceId: new Types.ObjectId(access.workspaceId),
          connectionId: database._id,
          databaseName:
            savedConsole.databaseName || database.connection.database,
          consoleId: savedConsole._id,
          source: apiKey ? "api" : "console_ui",
          databaseType: database.type,
          queryLanguage: mapConsoleLanguageToQueryLanguage(
            savedConsole.language,
          ),
          status: executionStatus,
          executionTimeMs: Date.now() - startTime,
          rowCount,
          errorType,
        });
      }

      return c.json(
        isPreviewMode
          ? {
              success: true,
              rows: previewRows || [],
              rowCount,
              fields: result.fields || null,
              pageInfo: "pageInfo" in result ? result.pageInfo || null : null,
              console: {
                id: savedConsole._id,
                name: savedConsole.name,
                language: savedConsole.language,
                executedAt: new Date().toISOString(),
              },
            }
          : {
              success: true,
              data: data,
              rowCount: rowCount,
              fields: result.fields || null,
              console: {
                id: savedConsole._id,
                name: savedConsole.name,
                language: savedConsole.language,
                executedAt: new Date().toISOString(),
              },
            },
      );
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error executing console", { error });

      // Track failed execution
      const user = c.get("user");
      const apiKey = c.get("apiKey");
      const userId = user?.id || apiKey?.createdBy;

      if (userId && database && workspaceId) {
        queryExecutionService.track({
          userId,
          apiKeyId: apiKey?._id,
          workspaceId: new Types.ObjectId(workspaceId),
          connectionId: database._id,
          databaseName: database.connection.database,
          consoleId: consoleIdParsed,
          source: apiKey ? "api" : "console_ui",
          databaseType: database.type,
          queryLanguage: mapConsoleLanguageToQueryLanguage(
            database.type === "mongodb" ? "mongodb" : "sql",
          ),
          status: "error",
          executionTimeMs: Date.now() - startTime,
          errorType: "unknown",
        });
      }

      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute console",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/export - Export console query results as Arrow IPC or JSON
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/export",
    tags: ["Consoles"],
    summary: "GET /{id}/export",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const consoleId = c.req.param("id");
      const format = (c.req.query("format") || "arrow") as
        | "arrow"
        | "json"
        | "ndjson"
        | "csv";
      const limit = parseInt(c.req.query("limit") || "500000", 10);

      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      if (!savedConsole.connectionId) {
        return c.json(
          { success: false, error: "Console has no database connection" },
          400,
        );
      }

      const database = await DatabaseConnection.findOne({
        _id: savedConsole.connectionId,
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!database) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      const startTime = Date.now();

      let query: any = savedConsole.code;
      if (
        savedConsole.language === "mongodb" &&
        (savedConsole as any).mongoOptions?.collection
      ) {
        query = {
          collection: (savedConsole as any).mongoOptions.collection,
          operation: (savedConsole as any).mongoOptions.operation || "find",
          query: savedConsole.code,
        };
      }

      if (
        (format === "ndjson" || format === "csv") &&
        typeof query === "string" &&
        database.type !== "cloudflare-kv"
      ) {
        const safety = checkPreviewQuerySafety(query);
        if (!safety.safe) {
          return c.json(
            {
              success: false,
              error: safety.errors.join(" "),
            },
            400,
          );
        }
      }

      if (format === "ndjson" || format === "csv") {
        const safeFileBase = sanitizeDownloadFilename(
          savedConsole.name || `console-${savedConsole._id.toString()}`,
        );
        const streamQuery =
          typeof query === "string" &&
          database.type !== "cloudflare-kv" &&
          database.type !== "mongodb"
            ? applySqlRowLimit({
                query,
                databaseType: database.type,
                limit,
              })
            : query;

        return createStreamingExportResponse({
          format,
          filename: `${safeFileBase}.${format === "csv" ? "csv" : "ndjson"}`,
          streamRows: emitRows =>
            databaseConnectionService.executeStreamingQuery(
              database,
              streamQuery,
              {
                databaseId: savedConsole.databaseId,
                databaseName: savedConsole.databaseName,
                batchSize: Math.max(1, Math.min(10000, limit)),
                signal: c.req.raw.signal,
                onBatch: emitRows,
                readOnly: true,
              },
            ),
        });
      }

      const result = await databaseConnectionService.executeQuery(
        database,
        query,
        {
          databaseId: savedConsole.databaseId,
          databaseName: savedConsole.databaseName,
          readOnly: true,
        },
      );

      if (!result.success || !result.data) {
        return c.json(
          { success: false, error: result.error || "Query execution failed" },
          500,
        );
      }

      const rows = Array.isArray(result.data) ? result.data : [];
      const limitedRows = rows.slice(0, limit);
      const fields = (result.fields || []).map((f: any) => ({
        name: f.name || f.columnName || String(f),
        type: f.type || f.dataType,
      }));

      if (fields.length === 0 && limitedRows.length > 0) {
        for (const key of Object.keys(limitedRows[0])) {
          fields.push({ name: key, type: undefined });
        }
      }

      const duration = Date.now() - startTime;

      if (format === "json") {
        return c.json({
          success: true,
          data: limitedRows,
          fields,
          rowCount: limitedRows.length,
          durationMs: duration,
        });
      }

      const { serializeToArrowIPC } = await import("../utils/arrow-serializer");
      const arrowBuffer = serializeToArrowIPC(limitedRows, fields, { limit });

      return new Response(arrowBuffer, {
        headers: {
          "Content-Type": "application/vnd.apache.arrow.stream",
          "X-Row-Count": String(limitedRows.length),
          "X-Export-Duration-Ms": String(duration),
        },
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error exporting console data", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Export failed",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/list - List all consoles (flat list for API clients)
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/list",
    tags: ["Consoles"],
    summary: "GET /list",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Access was verified by the router middleware; only the id is needed.
      const access = { workspaceId: c.req.param("workspaceId") as string };
      const user = c.get("user");

      const consoles = await consoleManager.listConsolesFlat(
        access.workspaceId,
        user?.id,
      );

      const connectionIds = [
        ...new Set(
          consoles
            .map(doc => doc.connectionId?.toString())
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const connections =
        connectionIds.length === 0
          ? []
          : await DatabaseConnection.find({
              _id: { $in: connectionIds.map(id => new Types.ObjectId(id)) },
              workspaceId: new Types.ObjectId(access.workspaceId),
            })
              .select("name type")
              .lean();
      const connectionById = new Map(
        connections.map(doc => [doc._id.toString(), doc]),
      );

      return c.json({
        success: true,
        consoles: consoles.map(console => {
          const connId = console.connectionId?.toString();
          const conn = connId ? connectionById.get(connId) : undefined;
          return {
            id: console._id,
            name: console.name,
            description: console.description,
            language: console.language,
            connection: conn
              ? { id: conn._id, name: conn.name, type: conn.type }
              : null,
            databaseName: console.databaseName,
            createdAt: console.createdAt,
            updatedAt: console.updatedAt,
            lastExecutedAt: console.lastExecutedAt,
            executionCount: console.executionCount,
            lastExternalUsedAt: console.lastExternalUsedAt ?? null,
            externalUseCount: console.externalUseCount ?? 0,
            lastExternalSource: console.lastExternalSource ?? null,
            access: ConsoleManager.resolveAccess(console),
            owner_id: console.owner_id || console.createdBy,
          };
        }),
        total: consoles.length,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true, consoles: [], total: 0 }, 200);
      }
      logger.error("Error listing consoles", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to list consoles",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/executions - Recent query execution logs
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/executions",
    tags: ["Consoles"],
    summary: "GET /{id}/executions",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Access was verified by the router middleware; only the id is needed.
      const access = { workspaceId: c.req.param("workspaceId") as string };

      const consoleId = c.req.param("id");
      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(access.workspaceId),
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      });

      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const user = c.get("user");
      if (
        user?.id &&
        !(await consoleManager.canReadWithInheritance(savedConsole, user.id))
      ) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const limitParam = c.req.query("limit");
      const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 10;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;

      const executions = await queryExecutionService.getConsoleExecutions(
        access.workspaceId,
        consoleId,
        { limit },
      );

      return c.json({
        success: true,
        executions: executions.map(execution => ({
          id: execution._id,
          executedAt: execution.executedAt,
          source: execution.source,
          sourceLabel: queryExecutionSourceLabel(execution.source),
          status: execution.status,
          executionTimeMs: execution.executionTimeMs,
          rowCount: execution.rowCount ?? null,
          errorType: execution.errorType ?? null,
          userId: execution.userId,
          apiKeyId: execution.apiKeyId ?? null,
          databaseType: execution.databaseType,
          queryLanguage: execution.queryLanguage,
        })),
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error listing console executions", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to list console executions",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/details - Get console details (for API clients)
consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/details",
    tags: ["Consoles"],
    summary: "GET /{id}/details",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Access was verified by the router middleware; only the id is needed.
      const access = { workspaceId: c.req.param("workspaceId") as string };

      const consoleId = c.req.param("id");

      // Validate console ID
      if (!Types.ObjectId.isValid(consoleId)) {
        return c.json({ success: false, error: "Invalid console ID" }, 400);
      }

      const consoleData = await consoleManager.getConsoleWithMetadata(
        consoleId,
        access.workspaceId,
      );

      if (!consoleData) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const savedConsole = consoleData._raw ?? null;
      if (!savedConsole) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const user = c.get("user");
      const resolvedAccess =
        consoleData.access || ConsoleManager.resolveAccess(savedConsole);
      const ownerId = consoleData.owner_id || savedConsole.createdBy;

      if (
        user?.id &&
        !(await consoleManager.canReadWithInheritance(savedConsole, user.id))
      ) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }

      const memberDetail = user?.id
        ? await workspaceService.getMember(access.workspaceId, user.id)
        : null;
      const isAdminDetail =
        memberDetail?.role === "owner" || memberDetail?.role === "admin";
      const readOnly = user?.id
        ? !ConsoleManager.canWrite(
            savedConsole,
            user.id,
            isAdminDetail,
            memberDetail?.role,
          )
        : false;

      let ownerDisplayName: string | undefined;
      if (ownerId) {
        const ownerUser = await User.findById(ownerId).select("email").lean();
        ownerDisplayName = ownerUser?.email;
      }

      // API-key clients reading console details count as external access.
      if (isApiKeyAuth(c)) {
        void consoleManager.recordExternalUse(
          savedConsole._id.toString(),
          access.workspaceId,
          "api",
          "access",
        );
      }

      const connection = await connectionSummary(
        consoleData.connectionId ?? savedConsole.connectionId,
        access.workspaceId,
      );

      return c.json({
        success: true,
        console: {
          id: consoleData.id ?? savedConsole._id,
          name: consoleData.name ?? savedConsole.name,
          description: consoleData.description ?? savedConsole.description,
          code: consoleData.content,
          language: consoleData.language ?? savedConsole.language,
          mongoOptions: consoleData.mongoOptions ?? savedConsole.mongoOptions,
          connection,
          databaseName: consoleData.databaseName ?? savedConsole.databaseName,
          createdAt: savedConsole.createdAt,
          updatedAt: savedConsole.updatedAt,
          lastExecutedAt: savedConsole.lastExecutedAt,
          executionCount: savedConsole.executionCount,
          lastExternalUsedAt: savedConsole.lastExternalUsedAt ?? null,
          externalUseCount: savedConsole.externalUseCount ?? 0,
          lastExternalSource: savedConsole.lastExternalSource ?? null,
          access: resolvedAccess,
          owner_id: ownerId,
          ownerDisplayName,
          readOnly,
        },
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: false, error: "Console not found" }, 404);
      }
      logger.error("Error getting console details", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get console details",
        },
        500,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Version history routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Git history — the same surface apps expose (apps.md §16): commits that
// touched the console's file, what one commit changed, a file before/after
// a commit, and restore-as-new-commit. Read from the repo; no sandbox.
// ---------------------------------------------------------------------------

const ConsoleIdParams = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

async function loadReadableConsole(
  c: Context,
  opts: { write: boolean },
): Promise<
  | { doc: ISavedConsole; userId: string; workspaceId: string }
  | { errorResponse: Response }
> {
  const workspaceId = c.req.param("workspaceId") as string;
  const consoleId = c.req.param("id");
  const user = (c as AuthenticatedContext).get("user");
  if (!user) {
    return {
      errorResponse: c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      ),
    };
  }
  if (!Types.ObjectId.isValid(consoleId)) {
    return {
      errorResponse: c.json(
        { success: false, error: "Invalid console ID" },
        400,
      ),
    };
  }
  const doc = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  const memberRole = (c as AuthenticatedContext).get("memberRole");
  if (!doc || !ConsoleManager.canRead(doc, user.id, memberRole)) {
    return {
      errorResponse: c.json(
        { success: false, error: "Console not found" },
        404,
      ),
    };
  }
  if (opts.write) {
    const isAdmin = memberRole === "owner" || memberRole === "admin";
    if (!ConsoleManager.canWrite(doc, user.id, isAdmin, memberRole)) {
      return {
        errorResponse: c.json(
          { success: false, error: "You do not have write access" },
          403,
        ),
      };
    }
  }
  return { doc, userId: user.id, workspaceId };
}

consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Consoles"],
    summary: "Commit history of a console (its file in the workspace repo)",
    security: AUTH_SECURITY,
    request: {
      params: ConsoleIdParams,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { limit } = c.req.valid("query");
      const commits = await consoleHistory(loaded.doc, limit ?? 50);
      return c.json({
        success: true as const,
        commits,
        path: loaded.doc.path ?? null,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error listing console history", { error });
      return c.json({ success: false, error: "Failed to list history" }, 500);
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/commit",
    tags: ["Consoles"],
    summary: "What one commit changed for this console",
    security: AUTH_SECURITY,
    request: {
      params: ConsoleIdParams,
      query: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { sha } = c.req.valid("query");
      const commit = await consoleCommitChanges(loaded.doc, sha);
      return c.json({ success: true as const, commit });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error reading console commit", { error });
      return c.json(
        { success: false, error: "Failed to read the commit" },
        500,
      );
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/file-versions",
    tags: ["Consoles"],
    summary: "A console file before and after one commit (for diffs)",
    security: AUTH_SECURITY,
    request: {
      params: ConsoleIdParams,
      query: z.object({
        sha: z.string().regex(/^[0-9a-f]{7,40}$/),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            p => !p.startsWith("/") && !p.split("/").includes(".."),
            "path must stay inside the repository",
          )
          .optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { sha, path: relPath } = c.req.valid("query");
      const target = relPath ?? loaded.doc.path;
      if (!target) {
        return c.json(
          { success: false, error: "Console has no file yet" },
          404,
        );
      }
      // Only this console's own file (and its chart) may be read through it.
      const own = new Set([
        loaded.doc.path,
        loaded.doc.path
          ? `${loaded.doc.path.replace(/\.[^./]+(\.js)?$/, "")}.chart.json`
          : undefined,
      ]);
      if (!own.has(target)) {
        return c.json(
          { success: false, error: "Path is not this console" },
          403,
        );
      }
      const versions = await consoleFileVersions(loaded.doc, sha, target);
      return c.json({ success: true as const, versions });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error reading console file versions", { error });
      return c.json({ success: false, error: "Failed to read the diff" }, 500);
    }
  },
);

consoleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Consoles"],
    summary: "Restore the console to a previous commit (as a new commit)",
    description:
      "Sets the console back to its content at `sha` and commits that on main. Nothing is rewritten: the versions in between stay in the history.",
    security: AUTH_SECURITY,
    request: {
      params: ConsoleIdParams,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { sha } = c.req.valid("json");
      const result = await restoreConsoleTo(loaded.doc, sha, loaded.userId);
      publishRealtimeEvent(loaded.workspaceId, {
        type: "console.updated",
        consoleId: loaded.doc._id.toString(),
        draftRevision: loaded.doc.draftRevision ?? 1,
        name: loaded.doc.name,
        updatedBy: loaded.userId,
        origin: "save",
      });
      requestConsoleDescription({
        workspaceId: loaded.workspaceId,
        consoleId: loaded.doc._id.toString(),
        tracking: { userId: loaded.userId },
      });
      return c.json({ success: true as const, result });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error restoring console", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Restore failed",
        },
        500,
      );
    }
  },
);

// ── Folder + move endpoints (shared registrar) ──

/**
 * Write access to a console folder via the shared resource ACL; the legacy
 * `isPrivate` flag stands in for `access` on folders that predate it.
 */
async function consoleFolderWriteDenied(
  ctx: { workspaceId: string; userId: string; role: string | undefined },
  folderId: string,
): Promise<{ ok: false; status: 403 | 404; error: string } | null> {
  const folder = await ConsoleFolder.findOne({
    _id: new Types.ObjectId(folderId),
    workspaceId: new Types.ObjectId(ctx.workspaceId),
  }).lean();
  if (!folder) return { ok: false, status: 404, error: "Folder not found" };
  const access = folder.access ?? (folder.isPrivate ? "private" : "workspace");
  const allowed = canWriteResource(
    { owner_id: folder.ownerId?.toString(), access },
    ctx.userId,
    ctx.role,
    { effectiveAccess: access },
  );
  return allowed ? null : { ok: false, status: 403, error: "Access denied" };
}

const consoleFolderBackend: FolderBackend = {
  createFolder: async (ctx, { name, parentId, access }) => {
    const folder = await consoleManager.createFolder(
      name,
      ctx.workspaceId,
      ctx.userId,
      parentId ?? undefined,
      false,
      access ?? "private",
    );
    return {
      ok: true,
      data: {
        id: folder._id.toString(),
        name: folder.name,
        parentId: folder.parentId?.toString(),
        isPrivate: folder.isPrivate,
      },
    };
  },

  renameFolder: async (ctx, { folderId, name }) => {
    const denied = await consoleFolderWriteDenied(ctx, folderId);
    if (denied) return denied;
    const success = await consoleManager.renameFolder(
      folderId,
      name,
      ctx.workspaceId,
      ctx.userId,
    );
    if (!success) return { ok: false, status: 404, error: "Folder not found" };
    return { ok: true };
  },

  deleteFolder: async (ctx, { folderId }) => {
    const denied = await consoleFolderWriteDenied(ctx, folderId);
    if (denied) return denied;
    const success = await consoleManager.deleteFolder(
      folderId,
      ctx.workspaceId,
      ctx.userId,
    );
    if (!success) return { ok: false, status: 404, error: "Folder not found" };
    return { ok: true };
  },

  moveFolder: async (ctx, { folderId, parentId, access }) => {
    const denied = await consoleFolderWriteDenied(ctx, folderId);
    if (denied) return denied;
    if (
      parentId &&
      (await wouldCreateFolderCycle(
        ConsoleFolder,
        folderId,
        parentId,
        ctx.workspaceId,
      ))
    ) {
      return {
        ok: false,
        status: 400,
        error: "Cannot move a folder into itself",
      };
    }
    const success = await consoleManager.moveFolder(
      folderId,
      ctx.workspaceId,
      parentId ?? null,
      access,
      ctx.userId,
    );
    if (!success) return { ok: false, status: 404, error: "Folder not found" };
    return { ok: true };
  },

  moveItem: async (ctx, { itemId, folderId, access }) => {
    if (Types.ObjectId.isValid(itemId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(itemId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
      });
      const isAdmin = ctx.role === "owner" || ctx.role === "admin";
      if (
        existing &&
        !ConsoleManager.canWrite(existing, ctx.userId, isAdmin, ctx.role)
      ) {
        return {
          ok: false,
          status: 403,
          error: "Cannot move a read-only console",
        };
      }
    }
    const success = await consoleManager.moveConsole(
      itemId,
      ctx.workspaceId,
      folderId ?? null,
      access,
      ctx.userId,
    );
    if (!success) return { ok: false, status: 404, error: "Console not found" };
    return { ok: true };
  },
};

registerFolderRoutes(consoleRoutes, {
  tag: "Consoles",
  schemaPrefix: "Console",
  backend: consoleFolderBackend,
  createdStatus: 201,
  onError: (c, error) =>
    error instanceof RepoRequiredError ? repoRequired(c, error) : undefined,
});
