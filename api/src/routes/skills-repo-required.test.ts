import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill mutations rewrite files under `skills/` in the workspace repo.
 * A throw nobody maps is a 500. The gate is a precondition the caller can
 * act on, so every mutating route must turn RepoRequiredError into 412.
 */

const skills = readFileSync(join(__dirname, "skills.ts"), "utf8");

assert.ok(
  /function repoRequired[\s\S]*?error\.status as 412/.test(skills),
  "skills routes must map RepoRequiredError to HTTP 412 via repoRequired()",
);

const lines = skills.split("\n");
const starts = lines
  .map((line, i) => (line.startsWith("skillsRoutes.openapi(") ? i : -1))
  .filter(i => i !== -1);
assert.ok(
  starts.length > 0,
  "no skill routes found — did the file's shape change?",
);
const blocks = starts.map((start, i) =>
  lines
    .slice(start, i + 1 < starts.length ? starts[i + 1] : lines.length)
    .join("\n"),
);

const describe = (block: string) => {
  const method = /method:\s*"(\w+)"/.exec(block)?.[1]?.toUpperCase() ?? "?";
  const path = /path:\s*"([^"]+)"/.exec(block)?.[1] ?? "?";
  return `${method} ${path}`;
};

const mutatesGit = (block: string) =>
  block.includes("saveSkill(") ||
  block.includes("deleteSkillById(") ||
  block.includes("toggleSkillSuppressed(");

let mutating = 0;
for (const block of blocks) {
  if (!mutatesGit(block)) continue;
  mutating++;
  assert.ok(
    block.includes("RepoRequiredError") && block.includes("repoRequired(c"),
    `${describe(block)} mutates a skill but does not map RepoRequiredError to 412 — the caller gets an opaque 500`,
  );
}

assert.ok(
  mutating >= 3,
  `expected at least 3 mutating skill routes, found ${mutating}`,
);

console.log(
  `skills repo-required tests passed (${mutating} mutating routes, all mapped to 412)`,
);
