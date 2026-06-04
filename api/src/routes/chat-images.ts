import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  getChatAttachmentForUser,
  openChatAttachmentStream,
} from "../services/chat-attachment.service";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { workspaceService } from "../services/workspace.service";

const logger = loggers.api("chat-images");

/**
 * Authenticated proxy that streams chat image attachments from object storage.
 *
 * Classification: Authenticated + workspace-scoped. Attachments are private to
 * the chat creator, mirroring the ownership model of the chats route.
 *
 * The browser fetches these lazily (`<img loading="lazy">`). Responses are
 * immutable (attachment ids are content-addressed) so they are aggressively
 * cached by the browser.
 */
export const chatImagesRoutes = new Hono();

chatImagesRoutes.use("*", unifiedAuthMiddleware);

// Verify workspace access (same defense-in-depth pattern as chats route).
chatImagesRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
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
  }
  await next();
});

function nodeStreamToWeb(
  nodeStream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        if (!closed) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      nodeStream.on("end", () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      nodeStream.on("error", (err: Error) => {
        if (!closed) {
          closed = true;
          controller.error(err);
        }
      });
    },
    cancel() {
      closed = true;
      if ("destroy" in nodeStream && typeof nodeStream.destroy === "function") {
        (
          nodeStream as NodeJS.ReadableStream & { destroy?: () => void }
        ).destroy?.();
      }
    },
  });
}

chatImagesRoutes.get("/:attachmentId", async (c: AuthenticatedContext) => {
  try {
    const user = c.get("user");
    const userId = user?.id;
    if (!userId) {
      return c.json({ error: "User not authenticated" }, 401);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;
    const attachmentId = c.req.param("attachmentId");

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }
    if (!ObjectId.isValid(attachmentId)) {
      return c.json({ error: "Invalid attachment id" }, 400);
    }

    const attachment = await getChatAttachmentForUser(
      attachmentId,
      workspaceId,
      userId.toString(),
    );
    if (!attachment) {
      return c.json({ error: "Attachment not found" }, 404);
    }

    // Content-addressed id => safe to cache forever in the browser.
    const etag = `"${attachment.sha256}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    const stream = await openChatAttachmentStream(attachment.storageKey);
    if (!stream) {
      logger.warn("Chat attachment bytes missing from object store", {
        attachmentId,
        workspaceId,
      });
      return c.json({ error: "Attachment not available" }, 404);
    }

    const headers: Record<string, string> = {
      "Content-Type": attachment.mediaType,
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      "Content-Length": String(attachment.size),
    };
    if (attachment.filename) {
      headers["Content-Disposition"] =
        `inline; filename="${attachment.filename.replace(/"/g, "")}"`;
    }

    return c.body(nodeStreamToWeb(stream), 200, headers);
  } catch (error) {
    logger.error("Error serving chat image", { error });
    return c.json({ error: "Failed to load attachment" }, 500);
  }
});
