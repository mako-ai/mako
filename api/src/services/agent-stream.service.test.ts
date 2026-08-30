/**
 * SSE→UIMessageChunk decoder for turn checkpointing (§13.27).
 * Run: tsx src/services/agent-stream.service.test.ts
 */
import assert from "node:assert/strict";
import { createSseChunkDecoder } from "./agent-stream.service";

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
}

void main();
