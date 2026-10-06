/**
 * Graceful rename of workspace skills (api/src/rename): the folder moves,
 * the old name is recorded as an alias in the file, one commit on main,
 * and every way of naming the skill — current name, alias, old id, a
 * bare laptop `git mv` — resolves to it. Same rig as
 * workspace-skills.service.test.ts: real bare repos, mongodb-memory-server
 * only for the workspace binding.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Spy on the git scan (real implementation) to prove the history cache.
vi.mock("../rename/git-renames", async importOriginal => {
  const actual = await importOriginal<typeof import("../rename/git-renames")>();
  return { ...actual, findRenamedFolder: vi.fn(actual.findRenamedFolder) };
});
import * as gitRenames from "../rename/git-renames";
import {
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
} from "./skill-files";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import {
  commitSkillRename,
  commitSkillSave,
  findSkill,
  findSkillById,
  invalidateSkillCatalog,
  loadSkillCatalog,
  resolveSkillRef,
  resolveSkillRefThroughHistory,
  skillId,
} from "./workspace-skills.service";
import { loadSkill, renameSkill, saveSkill } from "../services/skills.service";
import { skillRenameHandler } from "../rename/handlers/skill";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-rename-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = { workspaceId: WS, userId: "u1", role: "member" };

beforeEach(async () => {
  invalidateSkillCatalog(WS);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), MAIN, rel);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

async function pathsAtMain(): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  return (await listTree(repoDirFor(WS), head!)).map(e => e.path).sort();
}

const skill = (name: string, aliases?: string[]) => ({
  name,
  loadWhen: `when asked about ${name}`,
  entities: [name],
  suppressed: false,
  pinned: false,
  ...(aliases ? { aliases } : {}),
  body: `Do the ${name} thing.`,
});

describe("aliases in the file format", () => {
  it("round-trip; invalid or self aliases are dropped; absent when empty", () => {
    const text = serializeSkillFile(skill("new_name", ["old_name", "older"]));
    expect(text).toContain("aliases:");
    expect(parseSkillFile("new_name", text)?.aliases).toEqual([
      "old_name",
      "older",
    ]);
    expect(serializeSkillFile(skill("x"))).not.toContain("aliases");
    const messy = [
      "---",
      "description: d",
      "aliases: [new_name, 'Bad Name', 42, ok_one, ok_one]",
      "---",
      "body",
    ].join("\n");
    expect(parseSkillFile("new_name", messy)?.aliases).toEqual(["ok_one"]);
  });
});

describe("resolution: id → current name → alias", () => {
  it("a live name beats an alias; an alias claimed twice resolves to nothing", async () => {
    await commitSkillSave(WS, skill("mrr_v2", ["mrr"]));
    expect(await resolveSkillRef(WS, "mrr")).toMatchObject({
      via: "alias",
      skill: { name: "mrr_v2" },
    });
    expect(await resolveSkillRef(WS, "mrr_v2")).toMatchObject({
      via: "current",
    });
    // Old ids resolve through the alias too.
    expect(await findSkillById(WS, skillId(WS, "mrr"))).toMatchObject({
      name: "mrr_v2",
    });

    // A new skill takes the live name `mrr`: it wins over the alias.
    await commitSkillSave(WS, skill("mrr"));
    expect(await resolveSkillRef(WS, "mrr")).toMatchObject({
      via: "current",
      skill: { name: "mrr" },
    });

    // Two skills both claiming `legacy`: ambiguous, so neither.
    await commitSkillSave(WS, skill("a_skill", ["legacy"]));
    await commitSkillSave(WS, skill("b_skill", ["legacy"]));
    expect(await resolveSkillRef(WS, "legacy")).toBeNull();
    expect(await findSkill(WS, "legacy")).toBeNull();
    expect(await findSkillById(WS, skillId(WS, "legacy"))).toBeNull();
    expect(await resolveSkillRef(WS, "nobody")).toBeNull();
  });
});

describe("commitSkillRename", () => {
  it("moves the whole folder, writes the alias, in ONE commit on main", async () => {
    await commitSkillSave(WS, skill("mrr_walkthrough"));
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "skills/mrr_walkthrough/references/table.md": "# table\n",
          "skills/mrr_walkthrough/chart.png": Buffer.from([
            0x89, 0x50, 0, 0x47,
          ]),
        },
      },
      { message: "references" },
    );
    invalidateSkillCatalog(WS);
    const before = await log(repoDirFor(WS), MAIN, 50);

    const outcome = await commitSkillRename(WS, "mrr_walkthrough", "mrr_guide");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const after = await log(repoDirFor(WS), MAIN, 50);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].oid).toBe(outcome.commitOid);
    expect(after[0].subject).toBe(
      'Rename skill "mrr_walkthrough" -> "mrr_guide"',
    );
    expect(outcome.aliasesAdded).toEqual(["mrr_walkthrough"]);

    const paths = await pathsAtMain();
    expect(paths.filter(p => p.startsWith("skills/mrr_walkthrough/"))).toEqual(
      [],
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "skills/mrr_guide/SKILL.md",
        "skills/mrr_guide/references/table.md",
        "skills/mrr_guide/chart.png",
      ]),
    );
    const png = await readBlob(
      repoDirFor(WS),
      MAIN,
      "skills/mrr_guide/chart.png",
    );
    expect(png.isBinary).toBe(true);
    expect(Buffer.from(png.contents, "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0, 0x47]),
    );
    const file = await fileAt(skillFilePath("mrr_guide"));
    expect(file).toContain("name: mrr_guide");
    expect(file).toContain("- mrr_walkthrough");
    expect(file).toContain("Do the mrr_walkthrough thing."); // body intact

    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual(["mrr_guide"]);
    expect(catalog.skills[0].aliases).toEqual(["mrr_walkthrough"]);
    // The old name and the old id still find it.
    expect(await findSkill(WS, "mrr_walkthrough")).toMatchObject({
      name: "mrr_guide",
    });
    expect(
      await findSkillById(WS, skillId(WS, "mrr_walkthrough")),
    ).toMatchObject({ name: "mrr_guide" });
  });

  it("renaming again chains aliases; renaming back swaps them", async () => {
    await commitSkillSave(WS, skill("one"));
    await commitSkillRename(WS, "one", "two");
    await commitSkillRename(WS, "two", "three");
    expect((await findSkill(WS, "three"))?.aliases).toEqual(["one", "two"]);
    expect(await findSkill(WS, "one")).toMatchObject({ name: "three" });
    const back = await commitSkillRename(WS, "three", "one");
    expect(back.ok).toBe(true);
    expect((await findSkill(WS, "one"))?.aliases).toEqual(["two", "three"]);
    expect(await resolveSkillRef(WS, "one")).toMatchObject({ via: "current" });
  });

  it("refuses: bad names, unknown source, live target, another skill's alias, unparseable file", async () => {
    await commitSkillSave(WS, skill("alpha"));
    await commitSkillSave(WS, skill("beta_v2", ["beta"]));
    expect(await commitSkillRename(WS, "alpha", "Not Valid")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await commitSkillRename(WS, "alpha", "alpha")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await commitSkillRename(WS, "nope", "x")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await commitSkillRename(WS, "alpha", "beta_v2")).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await commitSkillRename(WS, "alpha", "beta")).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('previous name of the skill "beta_v2"'),
    });
    // A hand-written file that does not parse is refused, not rewritten.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/broken/SKILL.md": "no front matter here\n" } },
      { message: "broken" },
    );
    invalidateSkillCatalog(WS);
    // `broken` is not in the catalog (invalid), so it is "no skill named".
    expect(await commitSkillRename(WS, "broken", "fixed")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await fileAt("skills/broken/SKILL.md")).toBe(
      "no front matter here\n",
    );
    // Nothing moved in any refused case.
    expect(await fileAt(skillFilePath("alpha"))).not.toBeNull();
  });
});

describe("renameSkill / loadSkill / saveSkill through aliases", () => {
  it("renames by id, name or alias; load and save answer to the old name", async () => {
    await commitSkillSave(WS, skill("sales_playbook"));
    const oldId = skillId(WS, "sales_playbook");

    const r1 = await renameSkill(WS, oldId, "sales_guide", "u1");
    expect(r1).toMatchObject({
      success: true,
      before: { id: oldId, name: "sales_playbook" },
      skill: { name: "sales_guide", aliases: ["sales_playbook"] },
      aliasesAdded: ["sales_playbook"],
    });
    // The author rides on the commit.
    const [head] = await log(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toContain("sales_guide");

    // load_skill with the old name → the renamed skill.
    expect(await loadSkill(WS, "sales_playbook")).toMatchObject({
      success: true,
      skill: { name: "sales_guide", id: skillId(WS, "sales_guide") },
    });
    // save_skill under the CURRENT name updates it and keeps its aliases.
    const saved = await saveSkill(
      WS,
      { name: "sales_guide", loadWhen: "when selling", body: "Updated." },
      "u1",
    );
    expect(saved).toMatchObject({
      success: true,
      skill: { name: "sales_guide", created: false },
    });
    expect(await fileAt(skillFilePath("sales_guide"))).toContain("Updated.");
    expect((await findSkill(WS, "sales_guide"))?.aliases).toEqual([
      "sales_playbook",
    ]);

    // Rename by alias ref: moves from the CURRENT name.
    const r2 = await renameSkill(WS, "sales_playbook", "selling", "u1");
    expect(r2).toMatchObject({
      success: true,
      before: { name: "sales_guide" },
      skill: { name: "selling", aliases: ["sales_playbook", "sales_guide"] },
    });
    expect(await renameSkill(WS, "ghost", "x", "u1")).toMatchObject({
      success: false,
      status: 404,
    });
  });

  it("saving under a RETIRED name creates a new skill that takes the name; the alias is retired in the same commit", async () => {
    await commitSkillSave(WS, skill("revenue"));
    await renameSkill(WS, "revenue", "revenue_v1", "u1");
    expect(await resolveSkillRef(WS, "revenue")).toMatchObject({
      via: "alias",
    });
    const before = await log(repoDirFor(WS), MAIN, 50);

    const saved = await saveSkill(
      WS,
      { name: "revenue", loadWhen: "new revenue skill", body: "Fresh." },
      "u1",
    );
    expect(saved).toMatchObject({
      success: true,
      skill: { name: "revenue", created: true },
    });
    const after = await log(repoDirFor(WS), MAIN, 50);
    expect(after.length).toBe(before.length + 1); // one commit for both files
    expect(after[0].subject).toContain('retires the alias from "revenue_v1"');

    // The live name wins; the old skill is untouched except for the alias.
    expect(await resolveSkillRef(WS, "revenue")).toMatchObject({
      via: "current",
      skill: { name: "revenue", body: "Fresh." },
    });
    expect((await findSkill(WS, "revenue_v1"))?.aliases).toBeUndefined();
    expect(await fileAt(skillFilePath("revenue_v1"))).toContain(
      "Do the revenue thing.",
    );
    expect((await loadSkillCatalog(WS)).skills.map(s => s.name)).toEqual([
      "revenue",
      "revenue_v1",
    ]);
  });

  it("a workspace skill renamed away from a system skill's name stops shadowing it", async () => {
    // `apps` is a system skill; a workspace skill may take the name…
    await commitSkillSave(WS, skill("apps"));
    expect(await loadSkill(WS, "apps")).toMatchObject({
      success: true,
      skill: { id: skillId(WS, "apps") },
    });
    // …and once renamed, the system skill is visible again: order is
    // workspace current → system → workspace alias.
    await renameSkill(WS, "apps", "apps_house_rules", "u1");
    const loaded = await loadSkill(WS, "apps");
    expect(loaded.success).toBe(true);
    if (loaded.success) {
      expect(loaded.skill.name).toBe("apps");
      expect(loaded.skill.id).not.toBe(skillId(WS, "apps_house_rules"));
    }
    // A name no system skill has still reaches the alias.
    await commitSkillSave(WS, skill("kpi"));
    await renameSkill(WS, "kpi", "kpi_v2", "u1");
    expect(await loadSkill(WS, "kpi")).toMatchObject({
      success: true,
      skill: { name: "kpi_v2" },
    });
  });

  it("a bare laptop `git mv` (no alias written) still resolves through git history", async () => {
    await commitSkillSave(WS, skill("old_folder"));
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    const text = (
      await readBlob(repoDirFor(WS), head!, skillFilePath("old_folder"))
    ).contents;
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "skills/new_folder/SKILL.md": text },
        deletes: [skillFilePath("old_folder")],
      },
      { message: "git mv old_folder new_folder" },
    );
    invalidateSkillCatalog(WS);
    expect(await resolveSkillRef(WS, "old_folder")).toBeNull();
    expect(await resolveSkillRefThroughHistory(WS, "old_folder")).toMatchObject(
      {
        via: "alias",
        skill: { name: "new_folder" },
      },
    );
    expect(await loadSkill(WS, "old_folder")).toMatchObject({
      success: true,
      skill: { name: "new_folder" },
    });
    expect(await resolveSkillRefThroughHistory(WS, "never_was")).toBeNull();
    // The scan is cached per (main head, name): a second lookup spawns no git.
    const scans = vi.mocked(gitRenames.findRenamedFolder).mock.calls.length;
    await resolveSkillRefThroughHistory(WS, "old_folder");
    await resolveSkillRefThroughHistory(WS, "never_was");
    expect(vi.mocked(gitRenames.findRenamedFolder).mock.calls.length).toBe(
      scans,
    );
  });
});

describe("skillRenameHandler", () => {
  it("resolves current/alias/old-id refs and renames through the service", async () => {
    await commitSkillSave(WS, skill("kpi_defs"));
    const oldId = skillId(WS, "kpi_defs");
    expect(await skillRenameHandler.resolve(ctx, "kpi_defs")).toMatchObject({
      kind: "skill",
      id: oldId,
      via: "current",
      current: { slug: "kpi_defs", url: "/settings/skills" },
    });
    expect(await skillRenameHandler.resolve(ctx, "missing")).toBeNull();

    const result = await skillRenameHandler.rename(ctx, {
      ref: "kpi_defs",
      slug: "kpi_definitions",
    });
    expect(result).toMatchObject({
      kind: "skill",
      id: skillId(WS, "kpi_definitions"),
      before: { slug: "kpi_defs", path: "skills/kpi_defs/SKILL.md" },
      after: { slug: "kpi_definitions", url: "/settings/skills" },
      aliasesAdded: ["kpi_defs"],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.warnings[0]).toMatch(/id changed/);

    expect(await skillRenameHandler.resolve(ctx, "kpi_defs")).toMatchObject({
      via: "alias",
      current: { slug: "kpi_definitions" },
    });
    expect(await skillRenameHandler.resolve(ctx, oldId)).toMatchObject({
      via: "alias",
      id: skillId(WS, "kpi_definitions"),
    });
    await expect(
      skillRenameHandler.rename(ctx, {
        ref: "kpi_definitions",
        slug: "a",
        title: "b",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      skillRenameHandler.rename(ctx, {
        ref: "kpi_definitions",
        title: "Bad Name",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
