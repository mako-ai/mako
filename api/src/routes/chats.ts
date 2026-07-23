import { createRoute, z } from "@hono/zod-openapi";
import type { UIMessage } from "ai";
import { Chat } from "../database/workspace-schema";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { getConsolesByIds, saveChat } from "../services/agent-thread.service";
import { generateChatTitle } from "../services/title-generator";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { workspaceService } from "../services/workspace.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.api("chats");

/**
 * Extract unique console IDs the agent worked on (modify/create/open/run
 * tool calls) from chat messages. This is the reattach replay for UI
 * intents: reopening a chat restores the consoles the agent created, edited,
 * opened or ran — including work done while no window was attached.
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

function extractModifiedConsoleIds(
  messages: Array<{
    toolCalls?: Array<{ toolName: string; input?: any; result?: any }>;
  }>,
): string[] {
  const consoleIds = new Set<string>();

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (!CONSOLE_RESTORE_TOOL_NAMES.has(tc.toolName)) continue;
      // consoleId is in the input for tools targeting an existing console,
      // and in the result for create_console (the server mints the id).
      if (tc.input?.consoleId) consoleIds.add(tc.input.consoleId);
      if (tc.result?.consoleId) consoleIds.add(tc.result.consoleId);
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

// Apply unified auth middleware to all chat routes
chatsRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
chatsRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          { error: "API key not authorized for this workspace" },
          403,
        );
      }
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json({ error: "Access denied to workspace" }, 403);
      }
    } else {
      // Neither API key nor session auth succeeded - reject request
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// List chat sessions (most recent first)
chatsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Chats"],
    summary: "List chats",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Get authenticated user
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return c.json({ error: "User not authenticated" }, 401);
      }
      const workspaceId = c.req.param("workspaceId") as string;

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }

      // Filter by both workspaceId AND createdBy for privacy
      const chats = await Chat.find(
        {
          workspaceId: new ObjectId(workspaceId),
          createdBy: userId.toString(),
        },
        { messages: 0 },
      ).sort({ updatedAt: -1 });

      // Convert ObjectId to string for frontend convenience
      const mapped = chats.map(chat => ({
        ...chat.toObject(),
        _id: chat._id.toString(),
      }));

      return c.json(mapped);
    } catch (error) {
      logger.error("Error listing chats", { error });
      return c.json({ error: "Failed to list chats" }, 500);
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
      // Get authenticated user
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return c.json({ error: "User not authenticated" }, 401);
      }
      const workspaceId = c.req.param("workspaceId") as string;

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }

      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        // Ignore JSON parse errors – request body can be empty for this endpoint
      }

      const title = (body?.title as string) || "New Chat";

      const now = new Date();
      const chat = new Chat({
        workspaceId: new ObjectId(workspaceId),
        title,
        messages: [],
        createdBy: userId.toString(), // Set actual user ID
        titleGenerated: false,
        createdAt: now,
        updatedAt: now,
      });

      await chat.save();

      return c.json({ chatId: chat._id.toString() });
    } catch (error) {
      logger.error("Error creating chat", { error });
      return c.json({ error: "Failed to create chat" }, 500);
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
      // Get authenticated user
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return c.json({ error: "User not authenticated" }, 401);
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }

      if (!ObjectId.isValid(id)) {
        return c.json({ error: "Invalid chat id" }, 400);
      }

      // Filter by workspaceId, chat id, AND createdBy for privacy
      const chat = await Chat.findOne({
        _id: new ObjectId(id),
        workspaceId: new ObjectId(workspaceId),
        createdBy: userId.toString(),
      });

      if (!chat) {
        return c.json({ error: "Chat not found" }, 404);
      }

      // Extract console IDs from modify_console tool calls in chat messages
      // These are consoles that the agent modified during this conversation
      const modifiedConsoleIds = extractModifiedConsoleIds(chat.messages || []);

      // Fetch the consoles that were modified (they should be saved as drafts)
      const consoles = await getConsolesByIds(modifiedConsoleIds);

      return c.json({
        ...chat.toObject(),
        _id: chat._id.toString(),
        consoles, // Include consoles that were modified by the agent
      });
    } catch (error) {
      logger.error("Error getting chat", { error });
      return c.json({ error: "Failed to get chat" }, 500);
    }
  },
);

/**
 * Upsert full message history for a chat.
 *
 * Used by Local Agent ACP (Claude Code / Codex) turns that never hit
 * /api/agent/chat — the browser streams the turn locally, then persists the
 * UIMessage transcript here so History / reopen works like cloud chats.
 * Does not set activeStreamId (ACP turns are not resumable server-side).
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
        return c.json({ error: "User not authenticated" }, 401);
      }

      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }
      if (!ObjectId.isValid(id)) {
        return c.json({ error: "Invalid chat id" }, 400);
      }

      const body = c.req.valid("json");
      const messages = body.messages as unknown as UIMessage[];
      if (!Array.isArray(messages)) {
        return c.json({ error: "'messages' must be an array" }, 400);
      }

      // Ownership: refuse to upsert into another user's chat. New chats
      // (missing doc) are created by saveChat with this user as createdBy.
      const existing = await Chat.findOne({
        _id: new ObjectId(id),
        workspaceId: new ObjectId(workspaceId),
      }).select({ createdBy: 1, titleGenerated: 1 });

      if (existing && existing.createdBy !== userId.toString()) {
        return c.json({ error: "Chat not found" }, 404);
      }

      const saved = await saveChat(
        id,
        workspaceId,
        userId.toString(),
        messages,
      );
      if (!saved) {
        return c.json({ error: "Failed to save chat" }, 500);
      }

      if (body.localAcp) {
        await Chat.updateOne(
          {
            _id: new ObjectId(id),
            workspaceId: new ObjectId(workspaceId),
            createdBy: userId.toString(),
          },
          {
            $set: {
              localAcp: {
                providerId: body.localAcp.providerId,
                sessionId: body.localAcp.sessionId,
                modelId: body.localAcp.modelId,
              },
            },
          },
        );
      }

      // Fire-and-forget title on first persist (same pattern as agent.routes).
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
              await Chat.updateOne(
                { _id: new ObjectId(id), titleGenerated: false },
                { title, titleGenerated: true },
              );
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
      return c.json({ error: "Failed to save chat messages" }, 500);
    }
  },
);

// Update chat title (optional future use)
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
      // Get authenticated user
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return c.json({ error: "User not authenticated" }, 401);
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }

      if (!ObjectId.isValid(id)) {
        return c.json({ error: "Invalid chat id" }, 400);
      }

      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        // Ignore JSON parse errors – request body can be empty for this endpoint
      }

      const { title } = body;
      if (!title) {
        return c.json({ error: "'title' is required" }, 400);
      }

      // Only update if user owns the chat
      const result = await Chat.findOneAndUpdate(
        {
          _id: new ObjectId(id),
          workspaceId: new ObjectId(workspaceId),
          createdBy: userId.toString(),
        },
        { title, updatedAt: new Date() },
        { new: true },
      );

      if (!result) {
        return c.json({ error: "Chat not found" }, 404);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error updating chat", { error });
      return c.json({ error: "Failed to update chat" }, 500);
    }
  },
);

// Delete a chat session
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
      // Get authenticated user
      const user = c.get("user");
      const userId = user?.id;

      if (!userId) {
        return c.json({ error: "User not authenticated" }, 401);
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      if (!ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace id" }, 400);
      }

      if (!ObjectId.isValid(id)) {
        return c.json({ error: "Invalid chat id" }, 400);
      }

      // Only delete if user owns the chat
      const result = await Chat.findOneAndDelete({
        _id: new ObjectId(id),
        workspaceId: new ObjectId(workspaceId),
        createdBy: userId.toString(),
      });

      if (!result) {
        return c.json({ error: "Chat not found" }, 404);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting chat", { error });
      return c.json({ error: "Failed to delete chat" }, 500);
    }
  },
);
