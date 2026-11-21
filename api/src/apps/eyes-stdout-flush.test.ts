/**
 * The eyes runner must flush its result line before exiting.
 *
 * `console.log(line)` followed by `process.exit(0)` in the same tick can leave
 * a partial result. The reader then reports "Unparseable eyes result."
 *
 * The test stream emits the marker and the start of the JSON immediately,
 * then queues the rest for the next turn. Both snippets use this stream so
 * the result depends on when the child exits on any platform.
 *
 * Run: tsx src/apps/eyes-stdout-flush.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const MARK = "MAKO_EYES_RESULT:";
const PAYLOAD_BYTES = 300_000;

/** Run a snippet with stdout as a pipe (execFileSync pipes by default). */
function stdoutOf(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const emit = (body: string) => `
  import { Console } from "node:console";
  import { writeSync } from "node:fs";
  import { Writable } from "node:stream";

  const mark = ${JSON.stringify(MARK)};
  const big = "x".repeat(${PAYLOAD_BYTES});
  const line = mark + JSON.stringify({ screenshotBase64: big });
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      const split = mark.length + 1;
      writeSync(process.stdout.fd, chunk.subarray(0, split));
      setImmediate(() => process.stdout.write(chunk.subarray(split), done));
    },
  });
  const console = new Console({ stdout });
  ${body}
`;

const payloadOf = (stdout: string): string =>
  (
    JSON.parse(stdout.trim().slice(MARK.length)) as {
      screenshotBase64: string;
    }
  ).screenshotBase64;

function main() {
  const broken = stdoutOf(emit(`console.log(line); process.exit(0);`));
  assert.equal(broken, MARK + "{", "immediate exit loses the queued tail");
  assert.throws(
    () => payloadOf(broken),
    SyntaxError,
    "a cut line must fail to parse — that is the production symptom, " +
      '"Unparseable eyes result."',
  );

  const fixed = stdoutOf(
    emit(`stdout.write(line + "\\n", () => process.exit(0));`),
  );
  assert.ok(fixed.startsWith(MARK), "the complete result keeps its marker");
  assert.equal(
    payloadOf(fixed),
    "x".repeat(PAYLOAD_BYTES),
    "waiting for the callback delivers the whole payload",
  );

  // The shipped runner flushes the result line and writes the image to a file.
  const service = readFileSync(path.join(__dirname, "eyes.service.ts"), "utf8");
  const runnerStart = service.indexOf("function runnerSource()");
  // End at the template literal's terminator, not the first `\n}\n` — the
  // runner source is full of closing braces and an earlier marker silently
  // truncated the slice to a fraction of the body.
  const runner = service.slice(runnerStart, service.indexOf("`;", runnerStart));
  assert.ok(runner.includes("page.screenshot"), "runner body located");

  assert.match(
    runner,
    /process\.stdout\.write\(MARK \+ JSON\.stringify\(obj\)[\s\S]*?process\.exit\(0\)\)/,
    "runnerSource must exit from the write callback",
  );
  assert.doesNotMatch(
    runner,
    /console\.log\(MARK/,
    "runnerSource must not console.log the result line",
  );

  // The frame goes to a FILE and comes back as bytes over provider.readFile.
  // Putting it back in the line reintroduces ~100KB of base64 per browse and
  // with it the whole truncation class — the reason that class exists at all.
  assert.match(
    runner,
    /page\.screenshot\(\{[^}]*path: shotPath/,
    "the screenshot must be written to a file",
  );
  assert.doesNotMatch(
    runner,
    /encoding:\s*["']base64["']/,
    "the screenshot must NOT be encoded into the result line",
  );
  assert.doesNotMatch(
    runner,
    /screenshotBase64/,
    "the runner must not carry screenshotBase64 at all — the service fills " +
      "it from the bytes it reads back",
  );

  console.log(`eyes runner stdout-flush tests passed (${process.platform})`);
}

main();
