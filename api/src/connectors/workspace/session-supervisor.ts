/**
 * The session supervisor: the root process that sits between a session's
 * connector and the API (session-isolation.ts starts it).
 *
 * It reads the connector's stdout through a pipe and cuts it into batches:
 * every STATE line closes one. A batch is written to `<seq>.part` in the
 * root-only session directory and renamed to `<seq>.jsonl` when complete, so
 * the API reads a whole batch or nothing, in one `readFile`.
 *
 * It also:
 * - deletes the input files (the credential among them) as soon as the
 *   runner says it has read them (its `MAKO_SESSION` hello), and refuses a
 *   runner that never says so: one from before sessions ignores `--session`;
 * - holds the connector back when `--buffer` batches wait unacknowledged.
 *   It stops reading the pipe, the pipe fills and the connector blocks on
 *   its next write (stdout pipes are synchronous on Linux);
 * - bounds every batch at `--max-bytes` and `--max-messages`;
 * - ends the session when the API stops acknowledging for `--idle-ms` (the
 *   API died) or at `--deadline`: it kills the connector and lets the
 *   wrapper run the cleanup.
 *
 * Its last act is one word in `supervisor.out`: done, unsupported,
 * too-large-bytes, too-large-messages, abandoned or deadline.
 *
 * It runs as root on the pinned runtime Node, and treats every byte from the
 * connector as data: it splits lines, parses JSON to recognise two message
 * types, and never evaluates anything. It is a string here so the API can
 * write it into a box in the same command that starts a session.
 */
export const SESSION_SUPERVISOR_SOURCE = String.raw`// Mako connector session supervisor (api/src/connectors/workspace/session-supervisor.ts).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];

// The wrapper starts it in the session directory and names neither that
// directory nor the run's inputs in argv, which any user in the box can
// read: the directory is the cwd, the inputs come in the environment.
const dir = args.dir || process.cwd();
const batches = path.join(dir, "batches");
const maxBytes = Number(args["max-bytes"]);
const maxMessages = Number(args["max-messages"]);
const buffer = Math.max(1, Number(args.buffer) || 1);
const idleMs = Number(args["idle-ms"]);
const deadline = Number(args.deadline);
const inputs = (process.env.MAKO_SESSION_INPUTS || args.inputs || "").split(",").filter(Boolean);
delete process.env.MAKO_SESSION_INPUTS;
const heartbeat = path.join(dir, "heartbeat");
const NEWLINE = 10;

let seq = 1;
let fd = null;
let partBytes = 0;
let partMessages = 0;
let hello = false;
let finished = false;
let carry = Buffer.alloc(0);

function kill() {
  // Every process of the run user, at once (as the cleanup does). The local
  // test transport has no run user and names a process group instead.
  if (args.user) {
    spawnSync("runuser", ["-u", args.user, "--", "kill", "-9", "-1"], { stdio: "ignore" });
  } else if (args["kill-pgid"]) {
    try { process.kill(-Number(args["kill-pgid"]), "SIGKILL"); } catch {}
  }
}

function finish(reason) {
  if (finished) return;
  finished = true;
  if (fd !== null) {
    try { fs.closeSync(fd); } catch {}
    fd = null;
  }
  fs.writeFileSync(path.join(dir, "supervisor.out"), reason);
  if (reason !== "done") {
    try { fs.rmSync(path.join(batches, seq + ".part"), { force: true }); } catch {}
    kill();
    process.exit(0);
  }
}

function forgetInputs() {
  for (const file of inputs) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

function parse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function waiting() {
  let n = 0;
  for (const name of fs.readdirSync(batches)) if (name.endsWith(".jsonl")) n++;
  return n;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function watchdog() {
  if (finished) return;
  const now = Date.now();
  if (Number.isFinite(deadline) && now > deadline) return finish("deadline");
  let beat = 0;
  try { beat = fs.statSync(heartbeat).mtimeMs; } catch {}
  if (Number.isFinite(idleMs) && now - beat > idleMs) finish("abandoned");
}

/** One line of the connector's stdout, without its newline. */
async function line(bytes) {
  if (bytes.length === 0 || bytes.every(b => b === 32 || b === 9 || b === 13)) return;
  if (!hello) {
    const message = parse(bytes.toString("utf8"));
    if (message && message.type === "MAKO_SESSION") {
      hello = true;
      forgetInputs();
      return;
    }
    // A runner that failed before reading its inputs says why in a TRACE;
    // that is a failed read, not an old runner. Anything else is a runner
    // that ignored --session.
    if (!message || message.type !== "TRACE") return finish("unsupported");
  }
  if (fd === null) fd = fs.openSync(path.join(batches, seq + ".part"), "wx", 0o600);
  fs.writeSync(fd, bytes);
  fs.writeSync(fd, "\n");
  partBytes += bytes.length + 1;
  partMessages += 1;
  if (partBytes > maxBytes) return finish("too-large-bytes");
  if (partMessages > maxMessages) return finish("too-large-messages");
  // A STATE ends a batch. The prefix check keeps JSON.parse off every record.
  if (bytes.subarray(0, 15).toString() === '{"type":"STATE"') {
    const message = parse(bytes.toString("utf8"));
    if (!message || message.type !== "STATE") return;
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(path.join(batches, seq + ".part"), path.join(batches, seq + ".jsonl"));
    seq += 1;
    partBytes = 0;
    partMessages = 0;
    // Backpressure: the connector waits while the API is behind.
    while (!finished && waiting() >= buffer) {
      watchdog();
      await sleep(25);
    }
  }
}

setInterval(watchdog, 1000).unref();

for await (const chunk of process.stdin) {
  let data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  let start = 0;
  for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
    await line(data.subarray(start, i));
    if (finished) break;
    start = i + 1;
  }
  if (finished) break;
  carry = Buffer.from(data.subarray(start));
  if (carry.length > maxBytes) finish("too-large-bytes");
}

if (!finished) {
  if (carry.length) await line(carry);
  // A connector that printed nothing at all leaves no tail: the wrapper's
  // exit code and the captured stderr are the whole story.
  if (!finished && fd !== null) {
    // What came after the last STATE: a TRACE error, logs. The API reads it
    // with the connector's exit code.
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(path.join(batches, seq + ".part"), path.join(batches, seq + ".tail"));
  }
  finish("done");
}
process.exit(0);
`;
