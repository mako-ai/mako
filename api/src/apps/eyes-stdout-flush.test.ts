/**
 * The eyes runner must flush its result line before exiting.
 *
 * `console.log(line)` followed by `process.exit(0)` in the same tick discards
 * whatever has not drained, so a line past the pipe buffer reaches the reader
 * cut mid-string and `JSON.parse` fails — surfacing as the useless
 * "Unparseable eyes result.".
 *
 * The screenshot no longer travels in that line (it is written to a file and
 * read back as bytes), which removes the ~100KB of base64 that made this easy
 * to hit. The hazard is not gone though: the runner's own caps allow 120
 * console entries, 40 page errors and 40 failed requests at 600 chars each —
 * ~72KB of console output before any page text. A chatty app still overruns
 * the buffer, so the flush stays, and so does this test.
 *
 * WHERE the cut lands varies and is NOT worth asserting:
 *     macOS / node 24     300,000 B payload ->  65,536 B  (cut)
 *     Linux CI / node 20  300,000 B payload -> 219,264 B  (cut)
 * An earlier version asserted macOS's 65,536, passed locally and failed on CI
 * — and the mismatch read like "Linux does not truncate" when Linux truncates
 * too, just at a different boundary. Assert the property, not the number.
 *
 * Run: tsx src/apps/eyes-stdout-flush.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Comfortably past any buffer, and realistic: a dense-page JPEG in base64. */
const PAYLOAD_BYTES = 300_000;

/** Run a snippet with stdout as a pipe (execFileSync pipes by default). */
function stdoutOf(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const emit = (body: string) => `
  const big = "x".repeat(${PAYLOAD_BYTES});
  const line = "MAKO_EYES_RESULT:" + JSON.stringify({ screenshotBase64: big });
  ${body}
`;

const payloadOf = (stdout: string): string =>
  (
    JSON.parse(stdout.trim().slice("MAKO_EYES_RESULT:".length)) as {
      screenshotBase64: string;
    }
  ).screenshotBase64;

function main() {
  // 1. The hazard. Assert the PROPERTY — the line is cut and will not parse —
  //    never a byte count. The cut-off differs by platform (65,536 on macOS,
  //    219,264 on a Linux CI runner), and an earlier version of this test
  //    asserted macOS's number, passed locally, and failed on CI. Worse, the
  //    mismatch read like "Linux does not truncate" when Linux truncates too,
  //    just elsewhere. The number is the accident; the truncation is the bug.
  const broken = stdoutOf(emit(`console.log(line); process.exit(0);`));
  assert.ok(
    broken.length < PAYLOAD_BYTES,
    `the unflushed pattern must lose data (got ${broken.length} of ` +
      `${PAYLOAD_BYTES}+ bytes) — if it ever delivers the lot, node's ` +
      `stdout behaviour changed and the runner's guarantee needs re-deriving`,
  );
  assert.throws(
    () => JSON.parse(broken.slice("MAKO_EYES_RESULT:".length)),
    "a cut line must fail to parse — that is the production symptom, " +
      '"Unparseable eyes result."',
  );

  // 2. The shipped form is correct on EVERY platform. This is the assertion
  //    that actually protects the runner.
  const fixed = stdoutOf(
    emit(`process.stdout.write(line + "\\n", () => process.exit(0));`),
  );
  assert.ok(
    fixed.length > broken.length,
    `flushing must deliver more than not flushing (${fixed.length} vs ` +
      `${broken.length}) — same payload, same pipe, only the exit differs`,
  );
  assert.equal(
    payloadOf(fixed).length,
    PAYLOAD_BYTES,
    "the whole payload must survive, not just the part that fit the buffer",
  );

  // 3. The shipped runner: flushing form, and no image in the line.
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
