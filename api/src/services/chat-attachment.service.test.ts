/**
 * The vision gate on replayed chat attachments.
 *
 * This path replays the FULL chat history every turn, so a single image
 * attached once would otherwise break every subsequent turn on a text-only
 * model — the provider rejects the whole request rather than ignoring the
 * image.
 *
 * Run: tsx src/services/chat-attachment.service.test.ts
 */
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { resolveChatAttachmentsForModel } from "./chat-attachment.service";

const WORKSPACE = "0123456789abcdef01234567";

const msg = (parts: Array<Record<string, unknown>>): UIMessage =>
  ({ id: "m1", role: "user", parts }) as unknown as UIMessage;

const partTypes = (m: UIMessage) =>
  (m.parts as Array<{ type: string }>).map(p => p.type);

async function main() {
  const dataUrlImage = {
    type: "file",
    mediaType: "image/png",
    url: "data:image/png;base64,AAAA",
  };
  const proxyImage = {
    type: "file",
    url: `/api/workspaces/${WORKSPACE}/chat-images/0123456789abcdef01234568`,
  };
  const text = { type: "text", text: "what is in this picture?" };

  // Text-only model: every image shape is replaced by a placeholder, and the
  // proxy variant never even reaches storage.
  const blind = await resolveChatAttachmentsForModel(
    [msg([text, dataUrlImage, proxyImage])],
    WORKSPACE,
    { supportsVision: false },
  );
  assert.deepEqual(
    partTypes(blind[0]),
    ["text", "text", "text"],
    "no file part may survive for a text-only model",
  );
  const replaced = (blind[0].parts as Array<{ text: string }>)[1].text;
  assert.ok(/cannot read images/i.test(replaced), "placeholder explains why");
  assert.ok(!replaced.includes("AAAA"), "the base64 is not kept as text");

  // Vision model: a fresh data-URL image passes through untouched, and the
  // message object is returned as-is when nothing changed.
  const original = msg([text, dataUrlImage]);
  const seen = await resolveChatAttachmentsForModel([original], WORKSPACE, {
    supportsVision: true,
  });
  assert.equal(seen[0], original, "unchanged messages are not rebuilt");
  assert.deepEqual(partTypes(seen[0]), ["text", "file"]);

  // Unknown vision support (external MCP clients) assumes vision.
  const unknown = await resolveChatAttachmentsForModel(
    [msg([dataUrlImage])],
    WORKSPACE,
  );
  assert.deepEqual(partTypes(unknown[0]), ["file"]);

  // Non-image files are not touched by the vision gate.
  const pdf = await resolveChatAttachmentsForModel(
    [msg([{ type: "file", mediaType: "application/pdf", url: "https://x/y" }])],
    WORKSPACE,
    { supportsVision: false },
  );
  assert.deepEqual(partTypes(pdf[0]), ["file"]);

  console.log("chat attachment vision gate tests passed");
}

void main();
