/**
 * Unit tests for the pure Jupyter-message → KernelOutput mapper. Run via the
 * api `test` script (tsx). Message shapes mirror the real gateway frames
 * captured while validating against the gVisor kernel image.
 */
import assert from "node:assert/strict";

import { mapKernelMessage } from "./kernel-gateway-client";

function test(name: string, fn: () => void) {
  fn();
  console.log(`  ✓ ${name}`);
}

console.log("kernel-gateway-client mapKernelMessage");

test("maps stdout stream", () => {
  const out = mapKernelMessage({
    header: { msg_type: "stream" },
    content: { name: "stdout", text: "sum 45\n" },
  });
  assert.deepEqual(out, { type: "stream", name: "stdout", text: "sum 45\n" });
});

test("coerces unknown stream name to stdout", () => {
  const out = mapKernelMessage({
    header: { msg_type: "stream" },
    content: { name: "weird", text: "x" },
  });
  assert.equal(out?.type === "stream" && out.name, "stdout");
});

test("maps stderr stream", () => {
  const out = mapKernelMessage({
    header: { msg_type: "stream" },
    content: { name: "stderr", text: "oops" },
  });
  assert.equal(out?.type === "stream" && out.name, "stderr");
});

test("maps execute_result mime bundle (text/plain + text/html)", () => {
  const data = { "text/plain": "   a\n0  1", "text/html": "<table>…</table>" };
  const out = mapKernelMessage({
    header: { msg_type: "execute_result" },
    content: { data, execution_count: 3 },
  });
  assert.deepEqual(out, { type: "result", data });
});

test("maps display_data", () => {
  const data = { "image/png": "base64…" };
  const out = mapKernelMessage({
    header: { msg_type: "display_data" },
    content: { data },
  });
  assert.deepEqual(out, { type: "display", data });
});

test("maps error with traceback", () => {
  const out = mapKernelMessage({
    header: { msg_type: "error" },
    content: {
      ename: "ValueError",
      evalue: "bad",
      traceback: ["Traceback…", "ValueError: bad"],
    },
  });
  assert.deepEqual(out, {
    type: "error",
    ename: "ValueError",
    evalue: "bad",
    traceback: ["Traceback…", "ValueError: bad"],
  });
});

test("error tolerates a missing traceback", () => {
  const out = mapKernelMessage({
    header: { msg_type: "error" },
    content: { ename: "KeyError", evalue: "'x'" },
  });
  assert.equal(out?.type === "error" && Array.isArray(out.traceback), true);
});

test("ignores status / execute_input / unknown", () => {
  assert.equal(
    mapKernelMessage({
      header: { msg_type: "status" },
      content: { execution_state: "idle" },
    }),
    null,
  );
  assert.equal(
    mapKernelMessage({ header: { msg_type: "execute_input" }, content: {} }),
    null,
  );
  assert.equal(mapKernelMessage({ content: {} }), null);
});

test("reads msg_type from the top level when header lacks it", () => {
  const out = mapKernelMessage({
    msg_type: "stream",
    content: { name: "stdout", text: "hi" },
  });
  assert.equal(out?.type, "stream");
});

console.log("kernel-gateway-client: all passed");
