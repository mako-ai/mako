import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GET/list for skills must serve git at main. A missing GitHub binding is
 * an empty list (200), not 412 — leftover local git is not a read surface
 * (issue #956, after #961 made git the write store).
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

assert.ok(
  service.includes("loadLiveSkills") && service.includes("liveSkillToPlain"),
  "listSkillsForAdmin must list from loadLiveSkills, not Skill.find as the definition",
);

assert.ok(
  service.includes("loadLiveSkillById"),
  "getSkillForAdmin must resolve via loadLiveSkillById, not Skill.findOne as the definition",
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
    git.includes("listSkillDefinitionsAtMain") &&
    git.includes("loadLiveSkills"),
  "skill GET/list must read git via boundRepoDirIfExists / listSkillDefinitionsAtMain",
);

assert.ok(
  /if \(!\(await getWorkspaceRepo\(workspaceId\)\)\) return \[\]/.test(git),
  "listSkillDefinitionsAtMain must refuse leftover local git without a GitHub binding",
);

assert.ok(
  !/await ensureLocalRepo\(workspaceId\);\s*const repoDir = repoDirFor\(workspaceId\)/.test(
    git,
  ),
  "ensureSkillDerivedCache / listSkillDefinitionsAtMain must not treat leftover local git as a repo",
);

console.log("skills git-list tests passed");
