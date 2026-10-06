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

// A commit landing on main inside a rename's read→commit window (another
// window's save, a laptop push). Fired once, only for the rename's commit.
const race = vi.hoisted(() => ({
  before: undefined as undefined | (() => Promise<void>),
}));
vi.mock("./repository.service", async importOriginal => {
  const actual = await importOriginal<typeof import("./repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      if (race.before && /^(Rename|Save) skill/.test(args[3]?.message ?? "")) {
        const fn = race.before;
        race.before = undefined;
        await fn();
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});

// Spy on the git scan (real implementation) to prove the history cache.
vi.mock("../rename/git-renames", async importOriginal => {
  const actual = await importOriginal<typeof import("../rename/git-renames")>();
  return { ...actual, findRenamedFolder: vi.fn(actual.findRenamedFolder) };
});
import * as gitRenames from "../rename/git-renames";
import {
  editSkillFrontMatter,
  editSkillFrontMatterChecked,
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
  readBlobsBatch,
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
import {
  listSkillsForAdmin,
  loadSkill,
  renameSkill,
  saveSkill,
  toggleSkillSuppressed,
  updateSkillById,
} from "../services/skills.service";
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

describe("front matter is edited in place, never re-serialized", () => {
  const HAND_WRITTEN = [
    "---",
    "# owned by growth team",
    "name: old_name",
    "description: Use for X",
    "license: Proprietary",
    "allowed-tools: [Bash, Read]",
    "metadata:",
    "  owner: growth",
    "aliases: [older]",
    "---",
    "",
    "Body here.",
    "",
  ].join("\n");

  it("editSkillFrontMatter changes only name/aliases; flow and block lists; removal", () => {
    expect(
      editSkillFrontMatter(HAND_WRITTEN, {
        name: "new_name",
        aliases: ["older", "old_name"],
      }),
    ).toBe(
      HAND_WRITTEN.replace("name: old_name", "name: new_name").replace(
        "aliases: [older]",
        "aliases: [older, old_name]",
      ),
    );
    const block =
      "---\nname: a\ndescription: d\naliases:\n  - x\n  - y\npinned: true\n---\n\nbody\n";
    expect(editSkillFrontMatter(block, { aliases: ["x"] })).toBe(
      "---\nname: a\ndescription: d\npinned: true\naliases: [x]\n---\n\nbody\n",
    );
    expect(editSkillFrontMatter(block, { aliases: [] })).toBe(
      "---\nname: a\ndescription: d\npinned: true\n---\n\nbody\n",
    );
    expect(
      editSkillFrontMatter("---\ndescription: d\n---\nbody\n", {
        name: "n",
        aliases: ["o"],
      }),
    ).toBe("---\nname: n\ndescription: d\naliases: [o]\n---\nbody\n");
    expect(
      editSkillFrontMatter("no front matter\n", { aliases: ["o"] }),
    ).toBeNull();
  });

  it("rename and alias retirement keep comments, license, allowed-tools and metadata byte for byte", async () => {
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/old_name/SKILL.md": HAND_WRITTEN } },
      { message: "hand-written skill" },
    );
    invalidateSkillCatalog(WS);
    const renamed = await commitSkillRename(WS, "old_name", "new_name");
    expect(renamed.ok).toBe(true);
    expect(await fileAt(skillFilePath("new_name"))).toBe(
      HAND_WRITTEN.replace("name: old_name", "name: new_name").replace(
        "aliases: [older]",
        "aliases: [older, old_name]",
      ),
    );
    // A new skill takes `old_name`: the renamed skill's file loses only that alias.
    const saved = await saveSkill(
      WS,
      { name: "old_name", loadWhen: "fresh", body: "Fresh." },
      "u1",
    );
    expect(saved).toMatchObject({ success: true, skill: { created: true } });
    expect(await fileAt(skillFilePath("new_name"))).toBe(
      HAND_WRITTEN.replace("name: old_name", "name: new_name"),
    );
  });
});

describe("hand-written front matter the editor must handle, or refuse", () => {
  // A zero-indented block list is valid YAML and what people type by hand.
  const ZERO_INDENT = [
    "---",
    "name: foo",
    "description: Use for X",
    "aliases:",
    "- old",
    "license: MIT",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
  // A multi-line flow list: the line editor cannot extend this safely.
  const MULTILINE_FLOW = [
    "---",
    "name: foo",
    "description: Use for X",
    "aliases: [",
    "  old,",
    "  older ]",
    "license: MIT",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("editSkillFrontMatter consumes zero-indent items; refuses what it cannot keep parseable", () => {
    expect(
      editSkillFrontMatter(ZERO_INDENT, {
        name: "bar",
        aliases: ["old", "foo"],
      }),
    ).toBe(
      [
        "---",
        "name: bar",
        "description: Use for X",
        "license: MIT",
        "aliases: [old, foo]",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    expect(
      parseSkillFile(
        "bar",
        editSkillFrontMatter(ZERO_INDENT, {
          name: "bar",
          aliases: ["old", "foo"],
        })!,
      ),
    ).toMatchObject({
      aliases: ["old", "foo"],
    });
    expect(
      editSkillFrontMatter(MULTILINE_FLOW, {
        name: "bar",
        aliases: ["old", "older", "foo"],
      }),
    ).toBeNull();
    expect(
      editSkillFrontMatterChecked("bar", MULTILINE_FLOW, {
        name: "bar",
        aliases: ["foo"],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("edit SKILL.md by hand"),
    });
  });

  it("rename + retire of a zero-indent list keep the skill parseable and in the catalog", async () => {
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/foo/SKILL.md": ZERO_INDENT } },
      { message: "hand-written" },
    );
    invalidateSkillCatalog(WS);
    expect((await findSkill(WS, "foo"))?.aliases).toEqual(["old"]);
    const renamed = await commitSkillRename(WS, "foo", "bar");
    expect(renamed.ok).toBe(true);
    const catalog = await loadSkillCatalog(WS);
    expect(catalog.invalid).toEqual([]);
    expect(catalog.skills.map(s => [s.name, s.aliases])).toEqual([
      ["bar", ["old", "foo"]],
    ]);
    expect(await fileAt(skillFilePath("bar"))).toContain("license: MIT");
    // Retire `old` by creating a new skill with that name.
    const saved = await saveSkill(
      WS,
      { name: "old", loadWhen: "new", body: "New." },
      "u1",
    );
    expect(saved).toMatchObject({ success: true, skill: { created: true } });
    const after = await loadSkillCatalog(WS);
    expect(after.invalid).toEqual([]);
    expect(after.skills.map(s => [s.name, s.aliases])).toEqual([
      ["bar", ["foo"]],
      ["old", undefined],
    ]);
  });

  it("a front matter the editor cannot handle is refused (409) and the file is untouched", async () => {
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/foo/SKILL.md": MULTILINE_FLOW } },
      { message: "hand-written" },
    );
    invalidateSkillCatalog(WS);
    expect((await findSkill(WS, "foo"))?.aliases).toEqual(["old", "older"]);
    const before = await log(repoDirFor(WS), MAIN, 50);
    expect(await commitSkillRename(WS, "foo", "bar")).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining("edit SKILL.md by hand"),
    });
    // Retiring an alias from it (a new skill named `old`) is refused the same way.
    const saved = await saveSkill(
      WS,
      { name: "old", loadWhen: "new", body: "New." },
      "u1",
    );
    expect(saved).toMatchObject({
      success: false,
      error: expect.stringContaining("edit SKILL.md by hand"),
    });
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before.length);
    expect(await fileAt(skillFilePath("foo"))).toBe(MULTILINE_FLOW);
    expect(await fileAt(skillFilePath("bar"))).toBeNull();
    expect(await fileAt(skillFilePath("old"))).toBeNull();
    // Activation of a proposal under that name is refused too, nothing committed.
    const proposal = await saveSkill(
      WS,
      { name: "old", loadWhen: "p", body: "P." },
      "agent",
      { origin: "agent" },
    );
    expect(proposal).toMatchObject({
      success: true,
      skill: { pendingApproval: true },
    });
    const mid = await log(repoDirFor(WS), MAIN, 50);
    await expect(
      toggleSkillSuppressed(WS, skillId(WS, "old"), false, "u1"),
    ).rejects.toThrow(/edit SKILL.md by hand/);
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(mid.length);
    expect(await fileAt(skillFilePath("foo"))).toBe(MULTILINE_FLOW);
  });
});

describe("a SKILL.md that is not UTF-8", () => {
  it("is refused (400) and its bytes are untouched", async () => {
    const raw = Buffer.concat([
      Buffer.from("---\nname: latin\ndescription: caf"),
      Buffer.from([0xe9]),
      Buffer.from("\n---\n\nBody.\n"),
    ]);
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/latin/SKILL.md": raw } },
      { message: "latin-1 skill" },
    );
    invalidateSkillCatalog(WS);
    expect(await commitSkillRename(WS, "latin", "latin_v2")).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("not UTF-8"),
    });
    const after = (
      await readBlobsBatch(repoDirFor(WS), MAIN, ["skills/latin/SKILL.md"])
    ).get("skills/latin/SKILL.md");
    expect(after?.equals(raw)).toBe(true);
    expect(await fileAt(skillFilePath("latin_v2"))).toBeNull();
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

describe("moves keep modes and refuse a racing commit", () => {
  it("an executable helper stays executable, a symlink stays a symlink, blobs move by oid", async () => {
    await commitSkillSave(WS, skill("tooling"));
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "skills/tooling/scripts/run.sh": "#!/bin/sh\necho hi\n",
          "skills/tooling/latest": "SKILL.md",
          "skills/tooling/references/a.md": "# a\n",
        },
        modes: {
          "skills/tooling/scripts/run.sh": "100755",
          "skills/tooling/latest": "120000",
        },
      },
      { message: "helpers" },
    );
    invalidateSkillCatalog(WS);
    const head0 = await resolveCommit(repoDirFor(WS), MAIN);
    const before = Object.fromEntries(
      (await listTree(repoDirFor(WS), head0!))
        .filter(e => e.path.startsWith("skills/tooling/"))
        .map(e => [e.path.slice("skills/tooling/".length), [e.mode, e.oid]]),
    );
    expect(before["scripts/run.sh"][0]).toBe("100755");
    expect(before.latest[0]).toBe("120000");
    expect((await commitSkillRename(WS, "tooling", "tooling_v2")).ok).toBe(
      true,
    );
    const head1 = await resolveCommit(repoDirFor(WS), MAIN);
    const after = Object.fromEntries(
      (await listTree(repoDirFor(WS), head1!))
        .filter(e => e.path.startsWith("skills/tooling_v2/"))
        .map(e => [e.path.slice("skills/tooling_v2/".length), [e.mode, e.oid]]),
    );
    for (const rel of ["scripts/run.sh", "latest", "references/a.md"]) {
      expect(after[rel], rel).toEqual(before[rel]);
    }
    expect(after["SKILL.md"][1]).not.toBe(before["SKILL.md"][1]);
  });

  it("an edit to SKILL.md plus an added file landing before the commit: rename refused (409), both kept at the old path", async () => {
    await commitSkillSave(WS, skill("alpha", undefined));
    const original = (await fileAt(skillFilePath("alpha")))!;
    race.before = async () => {
      await commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        {
          writes: {
            [skillFilePath("alpha")]: original.replace(
              "Do the alpha thing.",
              "Body v2 — concurrent edit.",
            ),
            "skills/alpha/notes.md": "added concurrently\n",
          },
        },
        { message: "concurrent edit" },
      );
    };
    const refused = await renameSkill(WS, "alpha", "beta", "u1");
    expect(refused).toMatchObject({
      success: false,
      status: 409,
      error: expect.stringContaining("changed on main while renaming"),
    });
    expect(await fileAt(skillFilePath("alpha"))).toContain(
      "Body v2 — concurrent edit.",
    );
    expect(await fileAt("skills/alpha/notes.md")).toBe("added concurrently\n");
    expect(await fileAt(skillFilePath("beta"))).toBeNull();
    // With the window closed the rename goes through, carrying both.
    invalidateSkillCatalog(WS);
    expect((await renameSkill(WS, "alpha", "beta", "u1")).success).toBe(true);
    expect(await fileAt(skillFilePath("beta"))).toContain(
      "Body v2 — concurrent edit.",
    );
    expect(await fileAt("skills/beta/notes.md")).toBe("added concurrently\n");
  });
});

describe("an unapproved proposal under a renamed skill's old name does not hijack it", () => {
  it("load_skill(old) still answers with the approved skill; the proposal stays listed and approvable", async () => {
    await commitSkillSave(WS, skill("acme"));
    expect((await renameSkill(WS, "acme", "acme_v2", "u1")).success).toBe(true);
    const proposal = await saveSkill(
      WS,
      { name: "acme", loadWhen: "x", body: "UNAPPROVED BODY" },
      "agent",
      { origin: "agent" },
    );
    expect(proposal).toMatchObject({
      success: true,
      skill: { pendingApproval: true },
    });
    // Resolution: the suppressed current-name proposal loses to the live alias.
    expect(await loadSkill(WS, "acme")).toMatchObject({
      success: true,
      skill: { name: "acme_v2", suppressed: false },
    });
    expect(await resolveSkillRef(WS, "acme")).toMatchObject({
      via: "alias",
      skill: { name: "acme_v2" },
    });
    // Still in the catalog for the admin UI, by its own id.
    expect(
      (await listSkillsForAdmin(WS)).map(s => [s.name, s.suppressed]),
    ).toEqual([
      ["acme", true],
      ["acme_v2", false],
    ]);
    expect(await findSkillById(WS, skillId(WS, "acme"))).toMatchObject({
      name: "acme",
      suppressed: true,
    });
    // Approving it takes the name: the alias is retired and the live name wins.
    expect(
      await toggleSkillSuppressed(WS, skillId(WS, "acme"), false, "u1"),
    ).toBe(true);
    expect(await loadSkill(WS, "acme")).toMatchObject({
      success: true,
      skill: { name: "acme", body: "UNAPPROVED BODY" },
    });
    expect((await findSkill(WS, "acme_v2"))?.aliases).toBeUndefined();
  });
});

describe("a pending proposal under a retired name: write paths act on the file they name", () => {
  async function proposalUnderRetiredName() {
    await commitSkillSave(WS, skill("acme"));
    await renameSkill(WS, "acme", "acme_v2", "u1");
    await saveSkill(
      WS,
      { name: "acme", loadWhen: "x", body: "PROPOSAL" },
      "agent",
      { origin: "agent" },
    );
  }

  it("rename by id renames the proposal, not the live skill the name resolves to", async () => {
    await proposalUnderRetiredName();
    const r = await skillRenameHandler.rename(ctx, {
      ref: skillId(WS, "acme"),
      slug: "acme_proposal",
    });
    expect(r.before.slug).toBe("acme");
    expect(r.after.slug).toBe("acme_proposal");
    expect(
      (await listSkillsForAdmin(WS)).map(s => [
        s.name,
        s.suppressed,
        s.aliases,
      ]),
    ).toEqual([
      ["acme_proposal", true, ["acme"]],
      ["acme_v2", false, ["acme"]],
    ]);
    // `acme` is now claimed by both files: the suppressed proposal's alias
    // does not shadow the live skill's.
    expect(await loadSkill(WS, "acme")).toMatchObject({
      success: true,
      skill: { name: "acme_v2" },
    });
  });

  it("PUT /skills/:id (updateSkillById) edits the proposal in place: stays pending, retires nothing", async () => {
    await proposalUnderRetiredName();
    const before = await log(repoDirFor(WS), MAIN, 50);
    const r = await updateSkillById(
      WS,
      skillId(WS, "acme"),
      { body: "PROPOSAL (typo fixed)" },
      "u1",
    );
    expect(r).toMatchObject({ success: true, skill: { name: "acme" } });
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(
      before.length + 1,
    );
    expect(
      (await listSkillsForAdmin(WS)).map(s => [
        s.name,
        s.suppressed,
        s.aliases,
      ]),
    ).toEqual([
      ["acme", true, []],
      ["acme_v2", false, ["acme"]],
    ]);
    expect(await loadSkill(WS, "acme")).toMatchObject({
      success: true,
      skill: { name: "acme_v2", body: "Do the acme thing." },
    });
    expect(
      await updateSkillById(
        WS,
        "000000000000000000000000",
        { body: "x" },
        "u1",
      ),
    ).toMatchObject({ success: false, status: 404 });
  });

  it("saveSkill by name of a pending proposal keeps it pending and retires nothing", async () => {
    await proposalUnderRetiredName();
    const r = await saveSkill(
      WS,
      { name: "acme", loadWhen: "x", body: "edited by a user" },
      "u1",
    );
    expect(r).toMatchObject({
      success: true,
      skill: { name: "acme", created: false },
    });
    expect((await findSkillById(WS, skillId(WS, "acme")))?.suppressed).toBe(
      true,
    );
    expect((await findSkill(WS, "acme_v2"))?.aliases).toEqual(["acme"]);
    expect(await loadSkill(WS, "acme")).toMatchObject({
      success: true,
      skill: { name: "acme_v2" },
    });
  });

  it("retiring another skill's alias is pinned: a save racing it refuses instead of overwriting", async () => {
    await commitSkillSave(WS, skill("revenue"));
    await renameSkill(WS, "revenue", "revenue_v1", "u1");
    const path = skillFilePath("revenue_v1");
    const raw = (await fileAt(path))!;
    race.before = async () => {
      await commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        {
          writes: {
            [path]: raw.replace("Do the revenue thing.", "edited concurrently"),
          },
        },
        { message: "concurrent edit" },
      );
    };
    const saved = await saveSkill(
      WS,
      { name: "revenue", loadWhen: "new", body: "New." },
      "u1",
    );
    expect(saved).toMatchObject({
      success: false,
      error: expect.stringContaining("changed on main while saving"),
    });
    expect(await fileAt(path)).toContain("edited concurrently");
    expect(await fileAt(skillFilePath("revenue"))).toBeNull();
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

  it("an agent's SUPPRESSED proposal under a retired name does not retire the alias; activating it does", async () => {
    await commitSkillSave(WS, skill("pricing"));
    await renameSkill(WS, "pricing", "pricing_v1", "u1");
    const proposal = await saveSkill(
      WS,
      { name: "pricing", loadWhen: "proposal", body: "Proposed." },
      "agent",
      { origin: "agent" },
    );
    expect(proposal).toMatchObject({
      success: true,
      skill: { name: "pricing", created: true, pendingApproval: true },
    });
    // The real skill still answers to its old name in the file…
    expect((await findSkill(WS, "pricing_v1"))?.aliases).toEqual(["pricing"]);
    // …and a person activating the proposal retires it, in ONE commit.
    const before = await log(repoDirFor(WS), MAIN, 50);
    expect(
      await toggleSkillSuppressed(WS, skillId(WS, "pricing"), false, "u1"),
    ).toBe(true);
    const after = await log(repoDirFor(WS), MAIN, 50);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].subject).toContain('retires the alias from "pricing_v1"');
    expect((await findSkill(WS, "pricing_v1"))?.aliases).toBeUndefined();
    expect((await findSkill(WS, "pricing"))?.suppressed).toBe(false);
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
