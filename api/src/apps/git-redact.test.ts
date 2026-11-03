/**
 * GitError never carries credentials: a git process killed without output
 * (a timeout) fails with Node's own message — the whole command line,
 * `-c http.extraheader=Authorization: Basic <token>` included — and loggers
 * serialize error messages and stacks. This leaked a GitHub installation
 * token into Cloud Logging once (a slow mirror clone on a preview).
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitError, redactGitSecrets, runGit } from "./git";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

describe("redactGitSecrets", () => {
  it("strips auth headers, URL credentials and bare GitHub tokens", () => {
    const text = [
      `git -c http.extraheader=Authorization: Basic ${BASIC} clone`,
      `Authorization: Bearer ${TOKEN}`,
      `https://x-access-token:${TOKEN}@github.com/o/r.git`,
      `token ${TOKEN} here`,
    ].join("\n");
    const out = redactGitSecrets(text);
    expect(out).not.toContain(BASIC);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("Authorization: Basic [REDACTED]");
    expect(out).toContain("https://[REDACTED]@github.com/o/r.git");
  });

  it("leaves ordinary git output alone", () => {
    const text = "CONFLICT (content): Merge conflict in apps/x/mako.json";
    expect(redactGitSecrets(text)).toBe(text);
  });
});

describe("GitError", () => {
  it("redacts every field it is constructed with", () => {
    const err = new GitError(
      `git clone failed: Command failed: git -c http.extraheader=Authorization: Basic ${BASIC} clone`,
      ["-c", `http.extraheader=Authorization: Basic ${BASIC}`, "clone"],
      null,
      `fatal: https://u:${TOKEN}@github.com`,
      "",
    );
    const all = JSON.stringify({
      message: err.message,
      stack: err.stack,
      args: err.args,
      stderr: err.stderr,
    });
    expect(all).not.toContain(BASIC);
    expect(all).not.toContain(TOKEN);
  });

  it("a real git killed by its timeout reports no credentials", async () => {
    const dest = path.join(os.tmpdir(), `git-redact-${process.pid}`);
    const failure = await runGit(
      [
        "-c",
        `http.extraheader=Authorization: Basic ${BASIC}`,
        "clone",
        "--mirror",
        "--quiet",
        // A non-routable address: git hangs connecting until it is killed.
        "https://10.255.255.1/o/r.git",
        dest,
      ],
      { timeoutMs: 300 },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(GitError);
    const err = failure as GitError;
    expect(`${err.message}\n${err.stack}`).not.toContain(BASIC);
    expect(err.args.join(" ")).not.toContain(BASIC);
  });
});
