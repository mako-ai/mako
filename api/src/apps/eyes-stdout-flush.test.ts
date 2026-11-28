/**
 * The eyes runner must flush its result line before exiting.
 *
 * `console.log(line)` followed by `process.exit(0)` in the same tick can drop
 * queued stdout bytes. A partial result fails to parse and the service reports
 * "Unparseable eyes result."
 *
 * The screenshot no longer travels in that line (it is written to a file and
 * read back as bytes), which removes the ~100KB of base64 that made this easy
 * to hit. The hazard is not gone though: the runner's own caps allow 120
 * console entries, 40 page errors and 40 failed requests at 600 chars each —
 * ~72KB of console output before any page text. A chatty app still overruns
 * the buffer, so the flush stays, and so does this test.
 *
 * Keep the reader paused until the child has confirmed stdout is backlogged.
 * A reader that drains concurrently can pick up even the unflushed line in full.
 *
 * Run: tsx src/apps/eyes-stdout-flush.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const MARK = "MAKO_EYES_RESULT:";
const PAYLOAD_BYTES = 4 * 1024 * 1024;

function stdoutOf(exit: "immediate" | "after-write"): Promise<string> {
  const source = `
    import assert from "node:assert/strict";

    const line = ${JSON.stringify(MARK)} + JSON.stringify({
      screenshotBase64: "x".repeat(${PAYLOAD_BYTES}),
    });
    const exitAfterWrite = ${exit === "after-write"};
    if (exitAfterWrite) {
      process.stdout.write(line + "\\n", () => process.exit(0));
    } else {
      console.log(line);
    }
    assert.ok(process.stdout.writableLength > 0, "stdout must have queued bytes");
    if (exitAfterWrite) {
      process.send("stdout queued");
    } else {
      process.exit(0);
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        stdio: ["ignore", "pipe", "inherit", "ipc"],
        timeout: 30_000,
      },
    );
    child.once("error", reject);
    const { stdout } = child;
    assert.ok(stdout);
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdout.pause();
    // The flushing child asks the reader to drain via IPC once its write is
    // pending. The immediate-exit child keeps the reader paused until it exits.
    child.once("message", () => stdout.resume());
    child.once("exit", () => stdout.resume());
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`stdout fixture child exited with ${signal ?? code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function main() {
  const broken = await stdoutOf("immediate");
  assert.ok(broken.startsWith(MARK), "the truncated line keeps its marker");
  assert.ok(
    broken.length < PAYLOAD_BYTES,
    `immediate exit must lose queued data (read ${broken.length} bytes)`,
  );
  assert.throws(
    () => JSON.parse(broken.slice(MARK.length)),
    SyntaxError,
    "the truncated result must fail to parse",
  );

  const fixed = await stdoutOf("after-write");
  assert.equal(
    fixed,
    MARK +
      JSON.stringify({ screenshotBase64: "x".repeat(PAYLOAD_BYTES) }) +
      "\n",
    "waiting for the write callback must deliver the whole result line",
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
