/**
 * SSE→UIMessageChunk decoder for turn checkpointing (§13.27), and the vision
 * gate on screenshot attachments.
 * Run: tsx src/services/agent-stream.service.test.ts
 */
import assert from "node:assert/strict";
import {
  createSseChunkDecoder,
  buildScreenshotVisionModelMessage,
} from "./agent-stream.service";

async function collect(frames: Array<string | Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  const readable = new ReadableStream<string | Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  const decoded = readable.pipeThrough(createSseChunkDecoder());
  const reader = decoded.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

async function main() {
  // Frames split at awkward boundaries, bytes and strings mixed, one malformed.
  const enc = new TextEncoder();
  const chunks = await collect([
    'data: {"type":"start","messageId":"m1"}\n\ndata: {"type":"text-de',
    enc.encode('lta","id":"t1","delta":"hel'),
    'lo"}\n\n',
    "data: not-json\n\n",
    "data: [DONE]\n\n",
    enc.encode('data: {"type":"finish"}\n\n'),
  ]);
  assert.deepEqual(chunks, [
    { type: "start", messageId: "m1" },
    { type: "text-delta", id: "t1", delta: "hello" },
    { type: "finish" },
  ]);
  console.log("sse chunk decoder tests passed");

  screenshotVisionGateTests();
}

/**
 * Handing an image to a text-only model is not a graceful degradation — the
 * provider rejects the whole request ("messages.content.type is invalid,
 * allowed values: ['text']"), which kills the turn. This gate was the fix for
 * the largest single class of chat errors in production.
 */
function screenshotVisionGateTests() {
  const shot = {
    renderer: "modern-screenshot",
    filename: "active_tab.png",
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
    outputBytes: 3,
    targetLabel: "active_tab",
  };
  const partTypes = (msg: { content: Array<{ type: string }> } | null) =>
    (msg?.content ?? []).map(p => p.type);

  // Vision model: the image part is attached.
  const seen = buildScreenshotVisionModelMessage([shot], {
    supportsVision: true,
  });
  assert.ok(seen);
  assert.equal(seen.role, "user");
  assert.ok(
    partTypes(seen).includes("file"),
    "a vision model gets the image part",
  );

  // Unknown (external MCP clients) assumes vision.
  assert.ok(
    partTypes(buildScreenshotVisionModelMessage([shot], {})).includes("file"),
    "unknown vision support assumes vision",
  );
  assert.ok(
    partTypes(buildScreenshotVisionModelMessage([shot])).includes("file"),
    "omitted options assume vision",
  );

  // Text-only model: no image part survives, at all.
  const blind = buildScreenshotVisionModelMessage([shot], {
    supportsVision: false,
  });
  assert.ok(blind, "the model is still told a screenshot was taken");
  assert.deepEqual(
    partTypes(blind),
    ["text"],
    "a text-only model must receive no image part",
  );
  const note = (blind.content[0] as { text: string }).text;
  assert.ok(
    !note.includes("AAAA"),
    "the base64 is not smuggled into the text note",
  );
  assert.ok(
    /cannot (read|see)/i.test(note),
    "the note tells the model it cannot see, so it does not invent a description",
  );

  // No attachments is still nothing, blind or not.
  assert.equal(
    buildScreenshotVisionModelMessage([], { supportsVision: false }),
    null,
  );
  assert.equal(
    buildScreenshotVisionModelMessage(undefined, { supportsVision: false }),
    null,
  );

  // A non-image / oversized attachment is rejected before the gate, so a blind
  // model is not told about a screenshot that was never usable anyway.
  assert.equal(
    buildScreenshotVisionModelMessage(
      [{ ...shot, dataUrl: "not-a-data-url" }],
      { supportsVision: false },
    ),
    null,
  );

  console.log("screenshot vision gate tests passed");
}

void main();
