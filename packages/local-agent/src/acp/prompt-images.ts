/**
 * Validate image attachments on `/acp/sessions/:id/prompt` before they are
 * forwarded to the ACP adapter as `image` ContentBlocks. Invalid payloads
 * fail loudly — silently dropping an attachment looks like the model ignored
 * the user's screenshot.
 */
import type { AcpPromptImage } from "./types";

export const MAX_PROMPT_IMAGES = 10;
/** Per-image decoded size cap (matches typical provider limits ~5MB + slack). */
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
/** Total decoded size cap for one prompt. */
export const MAX_PROMPT_IMAGES_TOTAL_BYTES = 25 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function approxDecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Parse and validate the `images` field of a prompt request.
 * Returns a clean array (possibly empty); throws with a user-facing message
 * on any malformed entry.
 */
export function parsePromptImages(raw: unknown): AcpPromptImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("Prompt images must be an array");
  }
  if (raw.length === 0) return [];
  if (raw.length > MAX_PROMPT_IMAGES) {
    throw new Error(
      `Too many image attachments (${raw.length}). Limit is ${MAX_PROMPT_IMAGES} per message.`,
    );
  }

  let totalBytes = 0;
  const images: AcpPromptImage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each prompt image must be an object");
    }
    const { data, mimeType, uri } = entry as {
      data?: unknown;
      mimeType?: unknown;
      uri?: unknown;
    };
    if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
      throw new Error(
        `Unsupported attachment type${
          typeof mimeType === "string" ? ` (${mimeType})` : ""
        }. Only image attachments are supported.`,
      );
    }
    if (typeof data !== "string" || !data.trim()) {
      throw new Error("Prompt image is missing base64 data");
    }
    const cleaned = data.replace(/\s+/g, "");
    if (!BASE64_RE.test(cleaned)) {
      throw new Error("Prompt image data must be base64 (no data: URL prefix)");
    }
    const bytes = approxDecodedBytes(cleaned);
    if (bytes > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error(
        `Image attachment is too large (${Math.round(bytes / (1024 * 1024))}MB). Limit is ${Math.round(MAX_PROMPT_IMAGE_BYTES / (1024 * 1024))}MB per image.`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PROMPT_IMAGES_TOTAL_BYTES) {
      throw new Error(
        `Image attachments are too large together. Limit is ${Math.round(MAX_PROMPT_IMAGES_TOTAL_BYTES / (1024 * 1024))}MB per message.`,
      );
    }
    images.push({
      data: cleaned,
      mimeType,
      ...(typeof uri === "string" && uri ? { uri } : {}),
    });
  }
  return images;
}
