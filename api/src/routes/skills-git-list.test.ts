import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills are files at main and nothing else (apps.md §27): the routes must
 * read the catalog, the catalog must refuse leftover local git without a
 * GitHub binding, and no code path may reach for a Mongo skill row.
 */

const skills = readFileSync(join(__dirname, "skills.ts"), "utf8");
const service = readFileSync(
  join(__dirname, "../services/skills.service.ts"),
  "utf8",
);
const git = readFileSync(
  join(__dirname, "../apps/workspace-skills.service.ts"),
  "utf8",
);
const schema = readFileSync(
  join(__dirname, "../database/workspace-schema.ts"),
  "utf8",
);

assert.ok(
  service.includes("loadSkillCatalog") && service.includes("findSkillById"),
  "the skills service must read the git catalog",
);
assert.ok(
  !/\bSkill\.(find|findOne|create|updateOne|deleteOne)\b/.test(service) &&
    !/\bSkill\.(find|findOne|create|updateOne|deleteOne)\b/.test(git),
  "no skill code may touch a Mongo model",
);
assert.ok(
  !schema.includes('mongoose.model<ISkill>("Skill"'),
  "the Skill model must not exist",
);
assert.ok(
  /success:\s*true,\s*skills:\s*\[\]/.test(skills.replace(/\s+/g, "")) ||
    skills.includes("{ success: true, skills: [] }"),
  "GET /skills must return 200 { skills: [] } when no GitHub repo is bound",
);
assert.ok(
  skills.includes('error: "Skill not found"'),
  "GET /{id} must 404 when the file is missing or the workspace is unbound",
);
assert.ok(
  git.includes("boundRepoDirIfExists") &&
    /if \(!\(await getWorkspaceRepo\(workspaceId\)\)\) return emptyCatalog/.test(
      git,
    ),
  "the catalog must refuse leftover local git without a GitHub binding",
);
assert.ok(
  !/await ensureLocalRepo\(workspaceId\)/.test(git),
  "the catalog must not create a local repo as a side effect of reading",
);

console.log("skills git-list tests passed");
