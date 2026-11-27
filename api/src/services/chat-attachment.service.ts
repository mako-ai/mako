import crypto from "crypto";
import type { UIMessage } from "ai";
import { parseEntityId } from "../database/pg/id-codec";
import { chatRepo, type ChatAttachmentRecord } from "../repositories/chat";
import { getArtifactStore } from "./artifact-store.service";
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

function parseDataUrl(url: unknown): ParsedDataUrl | null {
  if (typeof url !== "string" || !url.startsWith("data:")) {
    return null;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }
  const header = url.slice(5, commaIndex);
  const isBase64 = header.includes(";base64");
  if (!isBase64) {
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

async function uploadChatImage(params: {
  workspaceId: string;
  chatId: string;
  createdBy: string;
  mediaType: string;
  buffer: Buffer;
  filename?: string;
}): Promise<ChatAttachmentRecord> {
  const { workspaceId, chatId, createdBy, mediaType, buffer, filename } =
    params;
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  const existing = await chatRepo.findAttachmentByHash(
    workspaceId,
    chatId,
    sha256,
  );
  if (existing) {
    return existing;
  }

  const storageKey = buildStorageKey(workspaceId, chatId, sha256);
  const store = getArtifactStore();
  await store.putBuffer(buffer, storageKey, mediaType, {
    workspaceId,
    chatId,
  });

  return chatRepo.createAttachmentIdempotent({
    workspaceId,
    chatId,
    createdBy,
    storageKey,
    mediaType,
    filename: filename ?? null,
    size: buffer.byteLength,
    sha256,
  });
}

function asRecord(part: unknown): Record<string, unknown> | null {
  if (typeof part === "object" && part !== null) {
    return part as Record<string, unknown>;
  }
  return null;
}

export async function externalizeChatAttachments(
  messages: UIMessage[],
  ctx: { workspaceId: string; chatId: string; userId: string },
): Promise<UIMessage[]> {
  if (!parseEntityId(ctx.chatId)) {
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
              url: buildChatImageProxyUrl(ctx.workspaceId, attachment.id),
              mediaType: attachment.mediaType,
            };
          } catch (error) {
            logger.error("Failed to externalize chat image attachment", {
              error,
              chatId: ctx.chatId,
              workspaceId: ctx.workspaceId,
            });
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

function isImagePart(p: Record<string, unknown>): boolean {
  if (p.type !== "file") return false;
  if (typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) {
    return true;
  }
  if (typeof p.url !== "string") return false;
  return p.url.startsWith("data:image/") || PROXY_URL_REGEX.test(p.url);
}

export async function resolveChatAttachmentsForModel(
  messages: UIMessage[],
  workspaceId: string,
  options: { supportsVision?: boolean } = {},
): Promise<UIMessage[]> {
  const store = getArtifactStore();
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
            return part;
          }
          const [, urlWorkspaceId, attachmentId] = match;
          if (urlWorkspaceId !== workspaceId) {
            return null;
          }
          try {
            const attachment = await chatRepo.findAttachmentById(
              workspaceId,
              attachmentId,
            );
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

export async function getChatAttachmentForUser(
  attachmentId: string,
  workspaceId: string,
  userId: string,
): Promise<ChatAttachmentRecord | null> {
  if (!parseEntityId(attachmentId) || !parseEntityId(workspaceId)) {
    return null;
  }
  return chatRepo.findAttachmentForUser(workspaceId, attachmentId, userId);
}

export async function openChatAttachmentStream(
  storageKey: string,
): Promise<NodeJS.ReadableStream | null> {
  const store = getArtifactStore();
  return await store.openReadStream(storageKey);
}
