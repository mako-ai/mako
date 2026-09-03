/**
 * A missing local repo must fail the write, never fall through to Mongo.
 *
 * `if (!repoDir) return` under api/src is how flows, dbt, and notebooks
 * used to swallow a missing git repo and leave Mongo as the only store.
 * New occurrences of that pattern are a regression of issue #956.
 *
 * Lookups that *return null so the caller can throw* live in the allowlist
 * below. Adding to the allowlist needs a reason, the same way
 * `test-coverage.test.ts` treats uncovered files.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");

/**
 * path → reasons, one per allowed line that matches the pattern.
 * Empty on purpose: every `if (!repoDir) return` under api/src was a
 * write-skip. Lookups use `repoExists` / `return null` instead.
 */
const ALLOWLIST: Readonly<Record<string, string[]>> = {};

const PATTERN = /if\s*\(\s*!repoDir\s*\)\s*return/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const hits: Array<{ rel: string; line: number; text: string }> = [];
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    if (PATTERN.test(text) && !text.trim().startsWith("//")) {
      hits.push({ rel, line: i + 1, text: text.trim() });
    }
  });
}

const leftover: typeof hits = [];
for (const hit of hits) {
  const allowed = ALLOWLIST[hit.rel];
  if (allowed && allowed.length > 0) {
    ALLOWLIST[hit.rel] = allowed.slice(1);
    continue;
  }
  leftover.push(hit);
}

assert.deepEqual(
  leftover,
  [],
  leftover
    .map(
      h =>
        `${h.rel}:${h.line}: ${h.text} — throw RepoRequiredError (or an explicit skippedReason) instead of silently returning`,
    )
    .join("\n"),
);

for (const [rel, remaining] of Object.entries(ALLOWLIST)) {
  assert.equal(
    remaining.length,
    0,
    `${rel} allowlist has unused entries — the silent skip was removed; delete the allowlist slot`,
  );
}

console.log(
  `no-silent-repo-skip: ${hits.length} allowlisted lookup(s), 0 write skips`,
);
