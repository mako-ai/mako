import assert from "node:assert/strict";
import {
  sanitizeToolFailureMessage,
  toolFailureFromOutput,
  toolFailureFromThrown,
} from "./tool-failure";

assert.equal(toolFailureFromOutput({ success: true }), null);
assert.equal(toolFailureFromOutput({ rows: [] }), null);
assert.deepEqual(
  toolFailureFromOutput({
    success: false,
    error: "warehouse refused",
    code: "BQ",
  }),
  { message: "warehouse refused", code: "BQ" },
);
assert.deepEqual(toolFailureFromOutput({ success: false }), {
  message: "Tool execution failed",
});
assert.deepEqual(toolFailureFromThrown(new Error("boom")), { message: "boom" });
assert.equal(
  sanitizeToolFailureMessage("failed with Bearer abcdefghijklmnop"),
  "failed with Bearer ***REDACTED***",
);
