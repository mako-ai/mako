import { Hono } from "hono";
import { Chat } from "../database/workspace-schema";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { getConsolesByIds } from "../services/agent-thread.service";

/**
 * Extract unique console IDs from modify_console tool calls in chat messages.
 * This is used to determine which consoles should be restored when opening a chat.
 */
function extractModifiedConsoleIds(
  messages: Array<{ toolCalls?: Array<{ toolName: string; input?: any }> }>,
): string[] {
  const consoleIds = new Set<string>();

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.toolName === "modify_console" && tc.input?.consoleId) {
        consoleIds.add(tc.input.consoleId);
      }
    }
  }

  return Array.from(consoleIds);
}

export const chatsRoutes = new Hono();

// Apply unified auth middleware to all chat routes
chatsRoutes.use("*", unifiedAuthMiddleware);

// List chat sessions (most recent first)
chatsRoutes.get("/", async (c: AuthenticatedContext) => {
  try {
    // Get authenticated user
    const user = c.get("user");
    const userId = user?.id;

    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
    console.error("Error listing chats:", error);
    return c.json({ error: "Failed to list chats" }, 500);
  }
});

// Create a new chat session
chatsRoutes.post("/", async (c: AuthenticatedContext) => {
  try {
    // Get authenticated user
    const user = c.get("user");
    const userId = user?.id;

    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
    console.error("Error creating chat:", error);
    return c.json({ error: "Failed to create chat" }, 500);
  }
});

// Get a single chat session with messages and associated consoles
chatsRoutes.get("/:id", async (c: AuthenticatedContext) => {
  try {
    // Get authenticated user
    const user = c.get("user");
    const userId = user?.id;

    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
    console.error("Error getting chat:", error);
    return c.json({ error: "Failed to get chat" }, 500);
  }
});

// Update chat title (optional future use)
chatsRoutes.put("/:id", async (c: AuthenticatedContext) => {
  try {
    // Get authenticated user
    const user = c.get("user");
    const userId = user?.id;

    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
    console.error("Error updating chat:", error);
    return c.json({ error: "Failed to update chat" }, 500);
  }
});

// Delete a chat session
chatsRoutes.delete("/:id", async (c: AuthenticatedContext) => {
  try {
    // Get authenticated user
    const user = c.get("user");
    const userId = user?.id;

    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
    console.error("Error deleting chat:", error);
    return c.json({ error: "Failed to delete chat" }, 500);
  }
});
