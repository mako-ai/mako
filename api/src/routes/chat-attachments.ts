import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { Chat } from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  buildChatAttachmentKey,
  decodeAttachmentKey,
  encodeAttachmentKey,
  getChatAttachmentStore,
} from "../services/chat-attachment-store.service";
import { workspaceService } from "../services/workspace.service";

const logger = loggers.api("chat-attachments");
const MAX_ATTACHMENT_BYTES = Number(
  process.env.CHAT_ATTACHMENT_MAX_BYTES || 10 * 1024 * 1024,
);

interface UploadedFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  type?: string;
  name?: string;
  size?: number;
}

function isUploadedFileLike(value: unknown): value is UploadedFileLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function nodeStreamToWeb(
  nodeStream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        if (!closed) {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            (
              nodeStream as NodeJS.ReadableStream & { pause?: () => void }
            ).pause?.();
          }
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      nodeStream.on("error", error => {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      });
    },
    pull() {
      (
        nodeStream as NodeJS.ReadableStream & { resume?: () => void }
      ).resume?.();
    },
    cancel() {
      closed = true;
      (
        nodeStream as NodeJS.ReadableStream & { destroy?: () => void }
      ).destroy?.();
    },
  });
}

async function verifyWorkspaceAccess(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<Response | null> {
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
  } else {
    return c.json({ error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  return null;
}

export const chatAttachmentRoutes = new Hono();

chatAttachmentRoutes.use("*", unifiedAuthMiddleware);

chatAttachmentRoutes.post("/", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  if (!ObjectId.isValid(workspaceId)) {
    return c.json({ error: "Invalid workspace id" }, 400);
  }

  const accessError = await verifyWorkspaceAccess(c, workspaceId);
  if (accessError) {
    return accessError;
  }

  const form = await c.req.raw.formData().catch(error => {
    logger.warn("Failed to parse chat attachment upload form", { error });
    return null;
  });
  if (!form) {
    return c.json({ error: "Invalid multipart form data" }, 400);
  }

  const chatId = String(form.get("chatId") || "");
  if (!ObjectId.isValid(chatId)) {
    return c.json({ error: "'chatId' is required and must be valid" }, 400);
  }

  const user = c.get("user");
  const existingChat = await Chat.findOne({
    _id: new ObjectId(chatId),
    workspaceId: new ObjectId(workspaceId),
  }).select({ createdBy: 1 });
  if (existingChat && user && existingChat.createdBy !== user.id) {
    return c.json({ error: "Access denied to chat" }, 403);
  }

  const uploaded = form.get("file");
  if (!isUploadedFileLike(uploaded)) {
    return c.json({ error: "'file' image upload is required" }, 400);
  }

  const mediaType = uploaded.type || "application/octet-stream";
  if (!mediaType.startsWith("image/")) {
    return c.json({ error: "Only image attachments are supported" }, 400);
  }

  if (
    typeof uploaded.size === "number" &&
    uploaded.size > MAX_ATTACHMENT_BYTES
  ) {
    return c.json({ error: "Image attachment is too large" }, 413);
  }

  const body = Buffer.from(await uploaded.arrayBuffer());
  if (body.byteLength > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: "Image attachment is too large" }, 413);
  }

  const key = buildChatAttachmentKey({
    workspaceId,
    chatId,
    filename: uploaded.name,
    mediaType,
  });
  await getChatAttachmentStore().putBuffer(key, body, mediaType, {
    workspaceId,
    chatId,
    filename: uploaded.name || "",
  });

  const attachmentId = encodeAttachmentKey(key);
  return c.json({
    url: `/api/workspaces/${workspaceId}/chat-attachments/${attachmentId}`,
    storageKey: key,
    attachmentId,
    mediaType,
    filename: uploaded.name || undefined,
    size: body.byteLength,
  });
});

chatAttachmentRoutes.get("/:attachmentId", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  if (!ObjectId.isValid(workspaceId)) {
    return c.json({ error: "Invalid workspace id" }, 400);
  }

  const accessError = await verifyWorkspaceAccess(c, workspaceId);
  if (accessError) {
    return accessError;
  }

  const key = decodeAttachmentKey(c.req.param("attachmentId"));
  if (!key || !key.split("/").includes(workspaceId)) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const store = getChatAttachmentStore();
  const [metadata, stream] = await Promise.all([
    store.getMetadata(key),
    store.openReadStream(key),
  ]);

  if (!metadata || !stream) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const headers: Record<string, string> = {
    "Content-Type": metadata.contentType,
    "Cache-Control": "private, max-age=86400, immutable",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie, Authorization",
  };
  if (metadata.size != null) {
    headers["Content-Length"] = String(metadata.size);
  }

  return c.body(nodeStreamToWeb(stream), 200, headers);
});
