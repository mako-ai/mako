import crypto from "crypto";
import { ObjectId } from "mongodb";
import type { UIMessage } from "ai";
import {
  ChatAttachment,
  type IChatAttachment,
} from "../database/workspace-schema";
import { getDashboardArtifactStore } from "./dashboard-artifact-store.service";
import { loggers } from "../logging";

const logger = loggers.agent();

const KEY_PREFIX = "chat-attachments";

/**
 * Matches the relative proxy URL we persist for chat image attachments:
 *   /api/workspaces/<workspaceId>/chat-images/<attachmentId>
 */
const PROXY_URL_REGEX =
  /\/api\/workspaces\/([a-f0-9]{24})\/chat-images\/([a-f0-9]{24})/i;

interface ParsedDataUrl {
  mediaType: string;
  buffer: Buffer;
}

/**
 * Parse a base64 `data:` URL into its media type and bytes. Returns null for
 * anything that is not a base64 data URL (e.g. an already-externalized proxy
 * URL or a remote https URL), which the caller should leave untouched.
 */
function parseDataUrl(url: unknown): ParsedDataUrl | null {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    return null;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }
  const header = url.slice(5, commaIndex); // e.g. "image/png;base64"
  const isBase64 = header.includes(";base64");
  if (!isBase64) {
    // We only externalize base64 payloads; non-base64 data URLs are rare and
    // left inline.
    return null;
  }
  const mediaType = header.split(";")[0] || "application/octet-stream";
  const data = url.slice(commaIndex + 1);
  try {
    const buffer = Buffer.from(data, "base64");
    if (buffer.byteLength === 0) {
      return null;
    }
    return { mediaType, buffer };
  } catch {
    return null;
  }
}

function buildStorageKey(
  workspaceId: string,
  chatId: string,
  sha256: string,
): string {
  return `${KEY_PREFIX}/${workspaceId}/${chatId}/${sha256}`;
}

/**
 * Build the relative, same-origin URL the browser uses to lazily fetch an
 * attachment through the authenticated proxy.
 */
export function buildChatImageProxyUrl(
  workspaceId: string,
  attachmentId: string,
): string {
  return `/api/workspaces/${workspaceId}/chat-images/${attachmentId}`;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    stream.on("data", chunk =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Upload a single image to object storage and return its attachment metadata,
 * deduplicating by content hash within the chat so repeated turns in the same
 * session do not create duplicate objects.
 */
async function uploadChatImage(params: {
  workspaceId: string;
  chatId: string;
  createdBy: string;
  mediaType: string;
  buffer: Buffer;
  filename?: string;
}): Promise<IChatAttachment> {
  const { workspaceId, chatId, createdBy, mediaType, buffer, filename } =
    params;
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  const existing = await ChatAttachment.findOne({
    workspaceId: new ObjectId(workspaceId),
    chatId,
    sha256,
  });
  if (existing) {
    return existing;
  }

  const storageKey = buildStorageKey(workspaceId, chatId, sha256);
  const store = getDashboardArtifactStore();
  await store.putBuffer(buffer, storageKey, mediaType, {
    workspaceId,
    chatId,
  });

  try {
    const created = await ChatAttachment.create({
      workspaceId: new ObjectId(workspaceId),
      chatId,
      createdBy,
      storageKey,
      mediaType,
      filename,
      size: buffer.byteLength,
      sha256,
    });
    return created;
  } catch (error) {
    // Unique-index race: another concurrent save inserted the same content.
    if ((error as { code?: number }).code === 11000) {
      const raced = await ChatAttachment.findOne({
        workspaceId: new ObjectId(workspaceId),
        chatId,
        sha256,
      });
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

function asRecord(part: unknown): Record<string, unknown> | null {
  if (typeof part === "object" && part !== null) {
    return part as Record<string, unknown>;
  }
  return null;
}

/**
 * Replace inline base64 image `file` parts with object-storage-backed proxy
 * URLs before the chat is persisted. This is the core of the fix: large base64
 * blobs no longer bloat the chat document (which previously risked exceeding
 * MongoDB's 16 MB BSON limit and silently dropping the whole save), so images
 * survive a reload.
 *
 * Returns a new messages array; the input is not mutated. On any per-image
 * failure the original (inline) part is preserved so the save still succeeds.
 */
export async function externalizeChatAttachments(
  messages: UIMessage[],
  ctx: { workspaceId: string; chatId: string; userId: string },
): Promise<UIMessage[]> {
  if (!ObjectId.isValid(ctx.chatId)) {
    // Externalized attachments key off the chat ObjectId; if it is not a valid
    // id (legacy/unexpected), skip externalization rather than fail the save.
    return messages;
  }

  let uploadedCount = 0;

  const result = await Promise.all(
    messages.map(async msg => {
      const parts = msg.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        return msg;
      }

      let changed = false;
      const newParts = await Promise.all(
        parts.map(async part => {
          const p = asRecord(part);
          if (!p || p.type !== "file") {
            return part;
          }
          const parsed = parseDataUrl(p.url);
          if (!parsed) {
            return part;
          }
          try {
            const attachment = await uploadChatImage({
              workspaceId: ctx.workspaceId,
              chatId: ctx.chatId,
              createdBy: ctx.userId,
              mediaType: parsed.mediaType,
              buffer: parsed.buffer,
              filename: p.filename as string | undefined,
            });
            changed = true;
            uploadedCount += 1;
            return {
              ...p,
              url: buildChatImageProxyUrl(
                ctx.workspaceId,
                attachment._id.toString(),
              ),
              mediaType: attachment.mediaType,
            };
          } catch (error) {
            logger.error("Failed to externalize chat image attachment", {
              error,
              chatId: ctx.chatId,
              workspaceId: ctx.workspaceId,
            });
            // Keep the inline data URL as a fallback so the save still works.
            return part;
          }
        }),
      );

      if (!changed) {
        return msg;
      }
      return { ...msg, parts: newParts as UIMessage["parts"] };
    }),
  );

  if (uploadedCount > 0) {
    logger.info("Externalized chat image attachments to object storage", {
      chatId: ctx.chatId,
      workspaceId: ctx.workspaceId,
      count: uploadedCount,
    });
  }

  return result;
}

/** An image part the model would have to *see* to make use of. */
function isImagePart(p: Record<string, unknown>): boolean {
  if (p.type !== "file") return false;
  if (typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) {
    return true;
  }
  if (typeof p.url !== "string") return false;
  // A /chat-images/ proxy URL is an image by construction, even on an old
  // part that never carried a mediaType.
  return p.url.startsWith("data:image/") || PROXY_URL_REGEX.test(p.url);
}

/**
 * Resolve internal proxy URLs back into base64 data URLs before replaying
 * history to the model. The model provider cannot fetch our authenticated,
 * relative proxy URL, so historical attachments (loaded from a reopened chat)
 * must be inlined again for the LLM. Freshly attached images in the current
 * turn already arrive as data URLs and pass through untouched.
 *
 * Parts that reference a missing/invalid attachment are dropped; the message
 * sanitizer downstream guards against empty parts arrays.
 *
 * `supportsVision: false` replaces every image part with a text placeholder.
 * A text-only model does not degrade when handed an image — the provider
 * rejects the whole request and the turn dies — and this path replays the
 * FULL history, so one image attached months ago would break every subsequent
 * turn on that model. The placeholder keeps the conversation coherent (the
 * model can see that something was attached) without shipping the bytes.
 * undefined = assume vision (external MCP clients, unknown models).
 */
export async function resolveChatAttachmentsForModel(
  messages: UIMessage[],
  workspaceId: string,
  options: { supportsVision?: boolean } = {},
): Promise<UIMessage[]> {
  const store = getDashboardArtifactStore();
  const blind = options.supportsVision === false;

  return await Promise.all(
    messages.map(async msg => {
      const parts = msg.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        return msg;
      }

      let changed = false;
      const resolvedParts = await Promise.all(
        parts.map(async part => {
          const p = asRecord(part);
          if (!p) return part;
          if (blind && isImagePart(p)) {
            changed = true;
            return {
              type: "text",
              text: "[image attachment omitted — the selected model cannot read images]",
            };
          }
          if (p.type !== "file" || typeof p.url !== "string") {
            return part;
          }
          const match = PROXY_URL_REGEX.exec(p.url);
          if (!match) {
            return part; // data URL or external URL — leave as-is
          }
          const [, urlWorkspaceId, attachmentId] = match;
          if (urlWorkspaceId !== workspaceId) {
            return null; // cross-workspace reference — drop defensively
          }
          try {
            const attachment = await ChatAttachment.findOne({
              _id: new ObjectId(attachmentId),
              workspaceId: new ObjectId(workspaceId),
            });
            if (!attachment) {
              return null;
            }
            const stream = await store.openReadStream(attachment.storageKey);
            if (!stream) {
              return null;
            }
            const buffer = await streamToBuffer(stream);
            const dataUrl = `data:${attachment.mediaType};base64,${buffer.toString(
              "base64",
            )}`;
            changed = true;
            return { ...p, url: dataUrl, mediaType: attachment.mediaType };
          } catch (error) {
            logger.warn("Failed to resolve chat attachment for model", {
              error,
              attachmentId,
              workspaceId,
            });
            return null;
          }
        }),
      );

      if (!changed) {
        return msg;
      }
      const filtered = resolvedParts.filter(
        (p): p is NonNullable<typeof p> => p !== null,
      );
      return { ...msg, parts: filtered as UIMessage["parts"] };
    }),
  );
}

/**
 * Load an attachment scoped to the requesting workspace + user. Chats are
 * private to their creator, so we enforce the same ownership check here.
 */
export async function getChatAttachmentForUser(
  attachmentId: string,
  workspaceId: string,
  userId: string,
): Promise<IChatAttachment | null> {
  if (!ObjectId.isValid(attachmentId) || !ObjectId.isValid(workspaceId)) {
    return null;
  }
  return await ChatAttachment.findOne({
    _id: new ObjectId(attachmentId),
    workspaceId: new ObjectId(workspaceId),
    createdBy: userId,
  });
}

export async function openChatAttachmentStream(
  storageKey: string,
): Promise<NodeJS.ReadableStream | null> {
  const store = getDashboardArtifactStore();
  return await store.openReadStream(storageKey);
}
