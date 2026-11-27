import { createRoute, z } from "@hono/zod-openapi";
import type { UIMessage } from "ai";
import { parseEntityId } from "../database/pg/id-codec";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  chatRecordToApiResponse,
  chatRepo,
  type StoredChatMessage,
} from "../repositories/chat";
import { getConsolesByIds, saveChat } from "../services/agent-thread.service";
import { getArtifactStore } from "../services/artifact-store.service";
import { generateChatTitle } from "../services/title-generator";
import { loggers } from "../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonContent,
  zDateTime,
} from "../openapi/core";
import {
  CHAT_LIST_DEFAULT_LIMIT,
  CHAT_LIST_MAX_LIMIT,
  ChatListCursorError,
  listUserChats,
} from "../services/chat-list.service";
import { fail } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.api("chats");

/**
 * Extract unique console IDs the agent worked on (modify/create/open/run
 * tool calls) from chat messages. Inspects normalized `parts[]` (`tool-*`
 * and `dynamic-tool`) as well as legacy `toolCalls[]`.
 */
const CONSOLE_RESTORE_TOOL_NAMES = new Set([
  "modify_console",
  "create_console",
  "open_console",
  "run_console",
  "check_query_status",
  "cancel_query",
  "set_console_connection",
]);

function extractConsoleIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { consoleId?: unknown }).consoleId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function extractModifiedConsoleIds(
  messages: Array<{
    parts?: Array<{
      type?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
    }>;
    toolCalls?: Array<{ toolName: string; input?: any; result?: any }>;
  }>,
): string[] {
  const consoleIds = new Set<string>();

  for (const msg of messages) {
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (!part || typeof part.type !== "string") continue;
        let toolName: string | null = null;
        if (part.type === "dynamic-tool") {
          toolName = typeof part.toolName === "string" ? part.toolName : null;
        } else if (part.type.startsWith("tool-")) {
          toolName =
            part.type.slice("tool-".length) ||
            (typeof part.toolName === "string" ? part.toolName : null);
        }
        if (!toolName || !CONSOLE_RESTORE_TOOL_NAMES.has(toolName)) continue;
        const inputId = extractConsoleIdFromPayload(part.input);
        if (inputId) consoleIds.add(inputId);
        const outputId = extractConsoleIdFromPayload(part.output);
        if (outputId) consoleIds.add(outputId);
      }
    }

    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        if (!CONSOLE_RESTORE_TOOL_NAMES.has(tc.toolName)) continue;
        const inputId = extractConsoleIdFromPayload(tc.input);
        if (inputId) consoleIds.add(inputId);
        const resultId = extractConsoleIdFromPayload(tc.result);
        if (resultId) consoleIds.add(resultId);
      }
    }
  }

  return Array.from(consoleIds);
}

export const chatsRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const ChatIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const ChatBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({ title: z.string().optional() }),
    },
  },
};

chatsRoutes.use("*", unifiedAuthMiddleware);
chatsRoutes.use("*", requireWorkspaceAccess());

const ChatListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CHAT_LIST_MAX_LIMIT)
    .optional()
    .openapi({
      param: { name: "limit", in: "query" },
      description: `Page size (default ${CHAT_LIST_DEFAULT_LIMIT}, max ${CHAT_LIST_MAX_LIMIT}).`,
    }),
  cursor: z
    .string()
    .max(512)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description:
        "Opaque `nextCursor` from the previous page. Omit for the first page.",
    }),
});

const ChatListEntrySchema = z
  .object({
    _id: z.string(),
    title: z.string(),
    createdAt: zDateTime().optional(),
    updatedAt: zDateTime().optional(),
    activeStreamId: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: "Set while a turn is generating server-side." }),
    usage: z
      .object({
        totalTokens: z.number().optional(),
        costUsd: z.number().optional(),
      })
      .optional(),
  })
  .openapi("ChatListEntry");

const ChatListResponseSchema = z
  .object({
    success: z.literal(true),
    chats: z.array(ChatListEntrySchema),
    nextCursor: z.string().nullable().openapi({
      description: "Pass back as `cursor` for the next page; null at the end.",
    }),
  })
  .openapi("ChatListResponse");

chatsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Chats"],
    summary: "List chats",
    description:
      "The caller's own chats in this workspace, most recently updated first, paginated by an opaque keyset cursor: pass `nextCursor` back as `cursor` until it is null. App chats and workflow-step runs are not listed. Entries carry only list metadata (title, timestamps, streaming pointer, token/cost totals) — fetch a chat by id for its messages. 400 on a cursor the server did not issue.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, query: ChatListQuery },
    responses: {
      ...OPEN_RESPONSES,
      200: jsonContent(ChatListResponseSchema, "One page of chats"),
    },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }
      const workspaceId = c.req.param("workspaceId") as string;

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }

      const { limit, cursor } = c.req.valid("query");
      const page = await listUserChats({
        workspaceId,
        userId: userId.toString(),
        limit,
        cursor: cursor || null,
      });

      return c.json({ success: true as const, ...page }, 200);
    } catch (error) {
      if (error instanceof ChatListCursorError) {
        return fail(c, error.status, error.message);
      }
      logger.error("Error listing chats", { error });
      return fail(c, 500, "Failed to list chats");
    }
  },
);

// Create a new chat session
chatsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Chats"],
    summary: "Create a chat",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: ChatBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }
      const workspaceId = c.req.param("workspaceId") as string;

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }

      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        // Ignore JSON parse errors – request body can be empty for this endpoint
      }

      const title = (body?.title as string) || "New Chat";
      const now = new Date();
      const chat = await chatRepo.create({
        workspaceId,
        title,
        messages: [],
        createdBy: userId.toString(),
        titleGenerated: false,
        createdAt: now,
        updatedAt: now,
      });

      return c.json({ chatId: chat.id });
    } catch (error) {
      logger.error("Error creating chat", { error });
      return fail(c, 500, "Failed to create chat");
    }
  },
);

// Get a single chat session with messages and associated consoles
chatsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Chats"],
    summary: "Get a chat",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }

      if (!parseEntityId(id)) {
        return fail(c, 400, "Invalid chat id");
      }

      const chat = await chatRepo.findOwnedById(
        workspaceId,
        id,
        userId.toString(),
      );

      if (!chat) {
        return fail(c, 404, "Chat not found");
      }

      const messages: StoredChatMessage[] = [...(chat.messages || [])];
      const checkpoint = chat.turnCheckpoint;
      if (
        checkpoint?.message &&
        chat.activeStreamId &&
        checkpoint.streamId === chat.activeStreamId &&
        Date.now() - new Date(checkpoint.at).getTime() > 120_000
      ) {
        messages.push(checkpoint.message as StoredChatMessage);
      }

      const modifiedConsoleIds = extractModifiedConsoleIds(messages);
      const consoles = await getConsolesByIds(modifiedConsoleIds);

      return c.json({
        ...chatRecordToApiResponse({ ...chat, messages }),
        consoles,
      });
    } catch (error) {
      logger.error("Error getting chat", { error });
      return fail(c, 500, "Failed to get chat");
    }
  },
);

/**
 * Upsert full message history for a chat (Local Agent ACP turns).
 */
chatsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/messages",
    tags: ["Chats"],
    summary: "Upsert chat messages",
    security: AUTH_SECURITY,
    request: {
      params: ChatIdParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              messages: z.array(z.record(z.string(), z.unknown())),
              localAcp: z
                .object({
                  providerId: z.string().min(1),
                  sessionId: z.string().min(1),
                  modelId: z.string().min(1),
                })
                .nullable()
                .optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;
      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }

      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }
      if (!parseEntityId(id)) {
        return fail(c, 400, "Invalid chat id");
      }

      const body = c.req.valid("json");
      const messages = body.messages as unknown as UIMessage[];
      if (!Array.isArray(messages)) {
        return fail(c, 400, "'messages' must be an array");
      }

      const existing = await chatRepo.findOwnershipMeta(workspaceId, id);
      if (existing && existing.createdBy !== userId.toString()) {
        return fail(c, 404, "Chat not found");
      }

      const saved = await saveChat(
        id,
        workspaceId,
        userId.toString(),
        messages,
        undefined,
        body.localAcp !== undefined ? { localAcp: body.localAcp } : undefined,
      );
      if (!saved) {
        return fail(c, 500, "Failed to save chat");
      }

      const needsTitle = existing == null || existing.titleGenerated === false;
      if (needsTitle) {
        const firstUserMessage = messages.find(m => m.role === "user");
        const userContent = firstUserMessage?.parts
          ? firstUserMessage.parts
              .filter(
                (p): p is { type: "text"; text: string } => p.type === "text",
              )
              .map(p => p.text)
              .join("")
          : "";
        if (userContent.length >= 3) {
          void (async () => {
            try {
              const title = await generateChatTitle(userContent, {
                workspaceId,
                userId: userId.toString(),
                userEmail: user?.email,
              });
              await chatRepo.setGeneratedTitleIfUnset(workspaceId, id, title);
            } catch (err) {
              logger.error("Background title generation failed", {
                error: err,
                chatId: id,
              });
            }
          })();
        }
      }

      return c.json({
        success: true,
        chatId: id,
        updatedAt: saved.updatedAt,
      });
    } catch (error) {
      logger.error("Error upserting chat messages", { error });
      return fail(c, 500, "Failed to save chat messages");
    }
  },
);

// Update chat title
chatsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Chats"],
    summary: "Update a chat title",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam, body: ChatBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }

      if (!parseEntityId(id)) {
        return fail(c, 400, "Invalid chat id");
      }

      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        // Ignore JSON parse errors
      }

      const { title } = body;
      if (!title) {
        return fail(c, 400, "'title' is required");
      }

      const updated = await chatRepo.updateTitle(
        workspaceId,
        id,
        userId.toString(),
        title,
      );

      if (!updated) {
        return fail(c, 404, "Chat not found");
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error updating chat", { error });
      return fail(c, 500, "Failed to update chat");
    }
  },
);

// Delete a chat session (transactional DB delete + post-commit blob purge)
chatsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Chats"],
    summary: "Delete a chat",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return fail(c, 401, "User not authenticated");
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }

      if (!parseEntityId(id)) {
        return fail(c, 400, "Invalid chat id");
      }

      const result = await chatRepo.deleteOwned(
        workspaceId,
        id,
        userId.toString(),
      );

      if (!result.deleted) {
        return fail(c, 404, "Chat not found");
      }

      if (result.deletedAttachmentKeys.length > 0) {
        const store = getArtifactStore();
        for (const key of result.deletedAttachmentKeys) {
          void store.delete(key).catch(err =>
            logger.warn("Failed to purge deleted chat attachment blob", {
              chatId: id,
              key,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting chat", { error });
      return fail(c, 500, "Failed to delete chat");
    }
  },
);
