/**
 * `app_browse` must hand the model a variant that actually carries a picture.
 *
 * Pinned because getting it wrong failed twice, in opposite ways, and neither
 * failure pointed back here: OpenAI 400s on `file-data` with an image MIME
 * type (killing the turn), while Anthropic silently drops it (the screenshot
 * never arrives and nothing says so). See browse-model-output.ts.
 *
 * Run: tsx src/agent-lib/tools/browse-model-output.test.ts
 */
import assert from "node:assert/strict";
import { buildBrowseModelOutput } from "./browse-model-output";

const RESULT = {
  success: true,
  ok: true,
  pageText: "Ubiflow",
  screenshotUrl: "/api/workspaces/x/apps/y/eyes-shots/z.jpg",
  screenshotBase64: "AAAA",
};

function main() {
  // 1. Vision model: the screenshot rides as an IMAGE part.
  const seen = buildBrowseModelOutput(RESULT, true);
  assert.equal(seen.type, "content");
  assert.equal(seen.value.length, 2);

  const [text, image] = seen.value as [
    { type: string; text: string },
    Record<string, unknown>,
  ];
  assert.equal(text.type, "text");
  assert.equal(
    image.type,
    "image-data",
    "an image must use the image-data variant — file-data means DOCUMENT, " +
      "which OpenAI 400s and Anthropic silently drops",
  );
  assert.equal(image.mediaType, "image/jpeg");
  assert.equal(image.data, "AAAA");
  assert.ok(
    !("filename" in image),
    "image-data carries no filename field in the v3 spec",
  );

  // The base64 must not be smuggled through the text part as well: as prose it
  // is ~25k tokens the model cannot see through.
  assert.ok(!text.text.includes("AAAA"), "base64 stays out of the text part");
  assert.ok(
    text.text.includes("screenshotUrl"),
    "the rest of the result survives alongside the image",
  );

  // 2. Text-only model: no image part, and no base64 leaking as text either.
  const blind = buildBrowseModelOutput(RESULT, false);
  assert.equal(blind.type, "json");
  assert.ok(
    !("screenshotBase64" in blind.value),
    "base64 stripped for text-only models",
  );
  assert.equal(blind.value.pageText, "Ubiflow");
  assert.equal(
    blind.value.screenshotUrl,
    "/api/workspaces/x/apps/y/eyes-shots/z.jpg",
    "the URL survives so a human can still open the shot",
  );

  // 3. Unknown vision support (external MCP clients) assumes vision.
  assert.equal(buildBrowseModelOutput(RESULT, undefined).type, "content");

  // 4. A result with no screenshot stays plain JSON.
  const noShot = buildBrowseModelOutput({ success: true, pageText: "x" }, true);
  assert.equal(noShot.type, "json");

  // 5. A failed browse (no object / null) does not throw.
  assert.equal(buildBrowseModelOutput(null, true).type, "json");
  assert.equal(buildBrowseModelOutput(undefined, false).type, "json");

  console.log("app_browse model-output variant tests passed");
}

main();
