import { createRoute, z } from "@hono/zod-openapi";
import { parseEntityId } from "../database/pg/id-codec";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  getChatAttachmentForUser,
  openChatAttachmentStream,
} from "../services/chat-attachment.service";
import { loggers } from "../logging";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { fail } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

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
export const chatImagesRoutes = createRouter();

chatImagesRoutes.use("*", unifiedAuthMiddleware);

// Verify workspace access (same defense-in-depth pattern as chats route).
chatImagesRoutes.use("*", requireWorkspaceAccess());

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

chatImagesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{attachmentId}",
    tags: ["Chat Images"],
    summary: "Stream a chat image attachment",
    description:
      "Streams a chat image attachment from object storage. Private to the chat creator.",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        attachmentId: z
          .string()
          .openapi({ param: { name: "attachmentId", in: "path" } }),
      }),
    },
    responses: {
      ...OPEN_RESPONSES,
      200: {
        description: "Attachment bytes.",
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      304: { description: "Not modified (matched `If-None-Match`)." },
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
      const attachmentId = c.req.param("attachmentId");

      if (!parseEntityId(workspaceId)) {
        return fail(c, 400, "Invalid workspace id");
      }
      if (!parseEntityId(attachmentId)) {
        return fail(c, 400, "Invalid attachment id");
      }

      const attachment = await getChatAttachmentForUser(
        attachmentId,
        workspaceId,
        userId.toString(),
      );
      if (!attachment) {
        return fail(c, 404, "Attachment not found");
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
        return fail(c, 404, "Attachment not available");
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
      return fail(c, 500, "Failed to load attachment");
    }
  },
);
