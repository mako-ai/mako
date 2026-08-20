/**
 * Convert composer image attachments (AI SDK `FileUIPart`s carrying base64
 * data URLs) into ACP prompt image payloads for the Local Agent bridge.
 */
import type { FileUIPart } from "ai";
import type { AcpPromptImage } from "./acp-types";

const DATA_URL_RE = /^data:([^;,]+)?((?:;[^;,]+)*);base64,(.*)$/s;

/**
 * Returns the image payloads plus how many attachments could not be converted
 * (non-image media, non-base64 or remote URLs). Callers surface `skipped`
 * instead of silently dropping — that silence was the original bug.
 */
export function fileUiPartsToAcpImages(files: FileUIPart[] | undefined): {
  images: AcpPromptImage[];
  skipped: number;
} {
  if (!files?.length) return { images: [], skipped: 0 };
  const images: AcpPromptImage[] = [];
  let skipped = 0;
  for (const file of files) {
    const match = DATA_URL_RE.exec(file.url || "");
    const mimeType = (file.mediaType || match?.[1] || "").trim();
    const data = match?.[3]?.replace(/\s+/g, "") || "";
    if (!match || !data || !mimeType.startsWith("image/")) {
      skipped += 1;
      continue;
    }
    images.push({ data, mimeType });
  }
  return { images, skipped };
}
