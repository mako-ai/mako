/**
 * "Is the sandbox gone?" — the predicate that gates every recovery from an
 * idle-killed box.
 *
 * It is tested against the SDK's REAL error objects, because the bug it was
 * written for was a mismatch with them: the classifier matched the message
 * "sandbox is not running", and E2B says "Sandbox is probably not running
 * anymore". One word in the middle, and every recovery this gates became dead
 * code — a dead box 500'd the dev-servers route (which promises an empty
 * answer) and a terminal whose box had gone logged one warning per keystroke
 * forever instead of reporting the exit. A test that invents its own error
 * string would have passed throughout.
 */
import assert from "node:assert/strict";
import { FileNotFoundError, SandboxNotFoundError, TimeoutError } from "e2b";
import { isSandboxGone } from "./e2b-provider";

// The exact object the SDK throws when a command starts against a box that is
// no longer running (handleProcessStartEvent, on a ConnectError/Unavailable).
const real = new SandboxNotFoundError(
  "Sandbox is probably not running anymore",
);
assert.ok(isSandboxGone(real), "the SDK's own error must be recognized");
assert.equal(real.name, "SandboxNotFoundError");

// The message alone, for an error that crossed a boundary that flattened it
// (a worker, a JSON round trip) and kept nothing but text.
assert.ok(
  isSandboxGone(new Error("Sandbox is probably not running anymore")),
  "the SDK's message must match even when the class is lost",
);
assert.ok(
  isSandboxGone({ name: "SandboxNotFoundError", message: "" }),
  "a plain object carrying the name must match",
);
for (const message of [
  "sandbox was not found",
  "The sandbox is not running",
  "404 not found: This error is expected",
]) {
  assert.ok(isSandboxGone(new Error(message)), `must match: ${message}`);
}

// Wrapped, the way an error looks after a layer adds context.
assert.ok(
  isSandboxGone(new Error("exec failed", { cause: real })),
  "a wrapped sandbox error is still a sandbox error",
);

// A missing FILE is not a missing MACHINE. FileNotFoundError shares a parent
// (NotFoundError) with the sandbox one, so accepting the parent would make
// every failed file read look like a dead box and recycle a live session.
assert.ok(
  !isSandboxGone(new FileNotFoundError("no such file")),
  "a missing file must not be read as a missing sandbox",
);

// Ordinary failures: the box is there, the command was unhappy.
assert.ok(!isSandboxGone(new TimeoutError("command timed out")));
assert.ok(!isSandboxGone(new Error("exit code 1")));
assert.ok(!isSandboxGone(new Error("ECONNRESET")));

// Non-errors must answer, not throw — this runs inside catch blocks.
for (const value of [null, undefined, "", 0, "gone", { message: 42 }]) {
  assert.equal(isSandboxGone(value), false, `must be false: ${String(value)}`);
}

// A cause cycle must not hang the process that is trying to report a failure.
const a = new Error("a");
const b = new Error("b", { cause: a });
(a as { cause?: unknown }).cause = b;
assert.equal(isSandboxGone(a), false, "a cause cycle must terminate");

console.log("sandbox-gone: all assertions passed");
