/**
 * Inline attachments embedded into transactional emails via Content-ID (RFC 2392).
 *
 * Why CID and not a remote URL?
 * - Many corporate mail clients block external images by default; CID images
 *   are part of the message itself and always render.
 * - Avoids hard-coding any production hostname into email templates and avoids
 *   needing a public asset CDN for branding.
 *
 * The SVG is read once at module load (`readFileSync` + base64) so subsequent
 * sends are zero-cost.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface InlineAttachment {
  /** Base64-encoded file contents (no `data:` prefix). */
  contentBase64: string;
  /** MIME type, e.g. `image/svg+xml` or `image/png`. */
  contentType: string;
  /** Filename suggested to the mail client. */
  filename: string;
  /** Used as `<img src="cid:<contentId>">`; must be unique per message. */
  contentId: string;
}

function loadSvgAttachment(
  relativePath: string,
  contentId: string,
  filename: string,
): InlineAttachment {
  const absolute = join(__dirname, relativePath);
  const buf = readFileSync(absolute);
  return {
    contentBase64: buf.toString("base64"),
    contentType: "image/svg+xml",
    filename,
    contentId,
  };
}

export const MAKO_LOGO_ATTACHMENT: InlineAttachment = loadSvgAttachment(
  "./mako-logo.svg",
  "mako-logo",
  "mako-logo.svg",
);

/** `data:` URI form — used by the dev email preview (browser can't resolve `cid:`). */
export function attachmentAsDataUri(att: InlineAttachment): string {
  return `data:${att.contentType};base64,${att.contentBase64}`;
}
