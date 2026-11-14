/**
 * Skills are files at main (apps.md §27): real bare repos under a temp
 * APPS_GIT_ROOT, no Mongo, no network. mongodb-memory-server is started only
 * because the workspace-repo binding helpers read the Workspace model.
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
import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_FILE_BYTES,
  SKILLS_README_PATH,
  MAX_SKILL_RESOURCES_PER_SKILL,
  MAX_SKILL_RESOURCE_BYTES,
  classifySkillResources,
  normalizeSkillResourcePath,
  parseSkillFile,
  parseSkillFileDetailed,
  serializeSkillFile,
  skillFilePath,
} from "./skill-files";
import * as repository from "./repository.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  log,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import {
  commitSkillDelete,
  commitSkillFlags,
  commitSkillSave,
  findSkill,
  findSkillById,
  invalidateSkillCatalog,
  resolveSkill,
  loadSkillCatalog,
  readWorkspaceSkillResource,
  skillId,
} from "./workspace-skills.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-skills-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

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

async function laptopCommit(
  writes: Record<string, string>,
  message = "laptop push",
): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes },
    { message },
  );
}

const skill = (
  name: string,
  body = "Do the thing.",
  extra: { pinned?: boolean; suppressed?: boolean } = {},
) => ({
  name,
  loadWhen: `when asked about ${name}`,
  entities: [name],
  suppressed: extra.suppressed ?? false,
  pinned: extra.pinned ?? false,
  body,
});

describe("format round-trip", () => {
  it("serializes and parses the SKILL.md package shape, flags included", () => {
    const file = serializeSkillFile(
      skill("mrr_walkthrough", "Do the thing.", { pinned: true }),
    );
    expect(file).toContain("description: when asked about mrr_walkthrough");
    expect(file).toContain("pinned: true");
    expect(file).not.toContain("suppressed");
    expect(parseSkillFile("mrr_walkthrough", file)).toMatchObject({
      name: "mrr_walkthrough",
      loadWhen: "when asked about mrr_walkthrough",
      entities: ["mrr_walkthrough"],
      suppressed: false,
      pinned: true,
      body: "Do the thing.",
    });
  });
});

describe("the catalog is the files at main", () => {
  it("lists what is committed, in name order, with stable ids; unbound reads empty", async () => {
    await commitSkillSave(WS, skill("zeta"));
    await commitSkillSave(WS, skill("alpha"));
    expect(await fileAt(SKILLS_README_PATH)).not.toBeNull();
    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual(["alpha", "zeta"]);
    expect(catalog.skills[0]!.id).toBe(skillId(WS, "alpha"));
    expect(catalog.invalid).toEqual([]);
    expect(await findSkillById(WS, skillId(WS, "zeta"))).toMatchObject({
      name: "zeta",
      path: skillFilePath("zeta"),
    });
    await unbindTestWorkspaceRepo(WS);
    expect((await loadSkillCatalog(WS)).skills).toEqual([]);
  });

  it("a push from elsewhere is visible on the next read; nothing else has to run", async () => {
    await commitSkillSave(WS, skill("synced"));
    expect((await findSkill(WS, "synced"))?.body).toBe("Do the thing.");
    await laptopCommit({
      [skillFilePath("synced")]: serializeSkillFile(
        skill("synced", "Do the BETTER thing."),
      ),
      [skillFilePath("new_from_laptop")]: serializeSkillFile(
        skill("new_from_laptop"),
      ),
    });
    expect((await findSkill(WS, "synced"))?.body).toBe("Do the BETTER thing.");
    expect(await findSkill(WS, "new_from_laptop")).not.toBeNull();
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: [skillFilePath("synced")] },
      { message: "laptop delete" },
    );
    expect(await findSkill(WS, "synced")).toBeNull();
  });

  it("is served from memory while main does not move", async () => {
    await commitSkillSave(WS, skill("cached"));
    const first = await loadSkillCatalog(WS);
    const again = await loadSkillCatalog(WS);
    expect(again).toBe(first);
    expect(first.head).toBe(await resolveCommit(repoDirFor(WS), MAIN));
    await commitSkillSave(WS, skill("cached", "v2"));
    const after = await loadSkillCatalog(WS);
    expect(after).not.toBe(first);
    expect(after.skills[0]!.body).toBe("v2");
  });

  it("a file that does not parse, or a folder with a bad name, is listed as invalid and never offered", async () => {
    await commitSkillSave(WS, skill("fine"));
    await laptopCommit({
      [skillFilePath("broken")]: "no frontmatter here\n",
      "skills/Bad-Name/SKILL.md": serializeSkillFile(skill("bad_name")),
    });
    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual(["fine"]);
    expect(catalog.invalid.map(i => [i.name, i.path])).toEqual([
      ["Bad-Name", "skills/Bad-Name/SKILL.md"],
      ["broken", skillFilePath("broken")],
    ]);
    expect(catalog.invalid.every(i => i.reason.length > 0)).toBe(true);
  });

  it("hyphenated folders are skills; `-` and `_` twins both load by exact name, never by a guess", async () => {
    await laptopCommit({
      "skills/app-ui-conventions/SKILL.md": serializeSkillFile(
        skill("app-ui-conventions"),
      ),
      "skills/foo-bar/SKILL.md": serializeSkillFile(skill("foo-bar", "hyphen")),
      "skills/foo_bar/SKILL.md": serializeSkillFile(
        skill("foo_bar", "underscore"),
      ),
      "skills/-lead/SKILL.md": serializeSkillFile(skill("lead")),
    });
    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual([
      "app-ui-conventions",
      "foo-bar",
      "foo_bar",
    ]);
    expect(catalog.invalid.map(i => i.name)).toEqual(["-lead"]);

    expect((await resolveSkill(WS, "app_ui_conventions"))?.name).toBe(
      "app-ui-conventions",
    );
    expect((await resolveSkill(WS, "foo-bar"))?.body).toBe("hyphen");
    expect((await resolveSkill(WS, "foo_bar"))?.body).toBe("underscore");
    // Two candidates and no exact match: nothing, rather than a coin flip.
    expect(await resolveSkill(WS, "FOO-BAR")).toBeNull();
    expect(await findSkill(WS, "app_ui_conventions")).toBeNull();
  });

  it("skill paths stay one safe segment", () => {
    expect(skillFilePath("app-ui-conventions")).toBe(
      "skills/app-ui-conventions/SKILL.md",
    );
    for (const bad of ["../x", "a/b", "a.b", "-x", "", "Upper"]) {
      expect(() => skillFilePath(bad), bad).toThrow(/Invalid skill name/);
    }
  });

  it("rejects oversized files and bodies before retaining them in the catalog", async () => {
    await laptopCommit({
      [skillFilePath("body_too_large")]: serializeSkillFile(
        skill("body_too_large", "x".repeat(MAX_SKILL_BODY_CHARS + 1)),
      ),
      [skillFilePath("file_too_large")]:
        "---\nname: file_too_large\ndescription: x\n---\n\n" +
        "y".repeat(MAX_SKILL_FILE_BYTES),
    });

    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills).toEqual([]);
    expect(catalog.invalid.map(file => file.reason)).toEqual([
      "body 20,001 chars over the 20,000 limit",
      "file 64,045 bytes over the 64,000 limit",
    ]);
  });
});

describe("writes are commits on main", () => {
  it("save, flags, delete each leave one commit and nothing else", async () => {
    await commitSkillSave(WS, skill("keeper"));
    expect(await commitSkillFlags(WS, "keeper", { suppressed: true })).toBe(
      true,
    );
    expect(await fileAt(skillFilePath("keeper"))).toContain("suppressed: true");
    expect(await commitSkillFlags(WS, "keeper", { pinned: true })).toBe(true);
    expect(await findSkill(WS, "keeper")).toMatchObject({
      suppressed: true,
      pinned: true,
    });
    // A no-op flip commits nothing.
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    expect(await commitSkillFlags(WS, "keeper", { pinned: true })).toBe(true);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);

    expect(await commitSkillDelete(WS, "keeper")).toBe(true);
    expect(await fileAt(skillFilePath("keeper"))).toBeNull();
    expect(await commitSkillDelete(WS, "never_committed")).toBe(false);
    expect(
      await commitSkillFlags(WS, "never_committed", { pinned: true }),
    ).toBe(false);
    const subjects = (await log(repoDirFor(WS), MAIN, 10)).map(c => c.subject);
    expect(subjects).toEqual(
      expect.arrayContaining([
        'Save skill "keeper"',
        'Suppress skill "keeper"',
        'Pin skill "keeper"',
        'Delete skill "keeper"',
      ]),
    );
  });

  it("refuses to write without a bound repo", async () => {
    await unbindTestWorkspaceRepo(WS);
    await expect(commitSkillSave(WS, skill("nope"))).rejects.toMatchObject({
      name: "RepoRequiredError",
    });
  });
});

describe("a hidden skill file says why", () => {
  it("names the limit and the size, or the front matter line", async () => {
    await laptopCommit({
      [skillFilePath("glossary")]: serializeSkillFile(
        skill("glossary", "x".repeat(24_713)),
      ),
      // One unquoted item: `plan: pro: annual` is not valid YAML.
      [skillFilePath("pricing")]:
        "---\nname: pricing\ndescription: Load for pricing questions\nentities:\n  - mrr\n  - arr\n  - plan: pro: annual\n---\n\nBody.\n",
      [skillFilePath("no_description")]: "---\nname: x\n---\n\nBody.\n",
      [skillFilePath("no_body")]: "---\nname: x\ndescription: y\n---\n",
      [skillFilePath("no_front_matter")]: "Just prose.\n",
      [skillFilePath("keeper")]: serializeSkillFile(skill("keeper")),
    });

    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual(["keeper"]);
    expect(catalog.invalid.map(file => [file.path, file.reason])).toEqual([
      ["skills/glossary/SKILL.md", "body 24,713 chars over the 20,000 limit"],
      ["skills/no_body/SKILL.md", "the body under the front matter is empty"],
      ["skills/no_description/SKILL.md", "front matter has no `description`"],
      [
        "skills/no_front_matter/SKILL.md",
        "no front matter: the file must start with a `---` block that holds `description`",
      ],
      [
        "skills/pricing/SKILL.md",
        "front matter line 7: bad indentation of a mapping entry",
      ],
    ]);
    // The old null-on-failure parser is unchanged for its callers.
    expect(parseSkillFile("pricing", "Just prose.\n")).toBeNull();
    expect(parseSkillFileDetailed("keeper", "Just prose.\n").ok).toBe(false);
  });

  it("a read git fails on is not a hidden skill: nothing is cached, the next read recovers", async () => {
    await laptopCommit({
      [skillFilePath("keeper")]: serializeSkillFile(skill("keeper")),
    });
    const read = vi
      .spyOn(repository, "readBlob")
      .mockRejectedValueOnce(new Error("git show timed out after 30000ms"));
    try {
      const flaky = await loadSkillCatalog(WS);
      expect(read).toHaveBeenCalledTimes(1);
      expect(flaky.incomplete).toBe(true);
      expect(flaky.skills).toEqual([]);
      expect(flaky.invalid.map(file => file.reason)).toEqual([
        "the file could not be read just now; retry",
      ]);
      const next = await loadSkillCatalog(WS);
      expect(next).not.toBe(flaky);
      expect(next.incomplete).toBeUndefined();
      expect(next.skills.map(s => s.name)).toEqual(["keeper"]);
      expect(next.invalid).toEqual([]);
      expect(await loadSkillCatalog(WS)).toBe(next);
    } finally {
      read.mockRestore();
    }
  });

  it("warns on a description the index cuts, and keeps the skill", async () => {
    const long = `${"Load when asked about revenue. ".repeat(8)}`.trim();
    expect(long.length).toBe(247);
    await laptopCommit({
      [skillFilePath("wordy")]: serializeSkillFile({
        ...skill("wordy"),
        loadWhen: long,
      }),
      [skillFilePath("terse")]: serializeSkillFile(skill("terse")),
    });

    const catalog = await loadSkillCatalog(WS);
    expect(catalog.skills.map(s => s.name)).toEqual(["terse", "wordy"]);
    expect(catalog.invalid).toEqual([]);
    expect(catalog.warnings).toEqual([
      {
        name: "wordy",
        path: "skills/wordy/SKILL.md",
        reason: "description 247 chars: the index shows the first 200",
      },
    ]);
  });
});

describe("skill resources", () => {
  const folder = "skills/recon";

  async function seed(): Promise<void> {
    await laptopCommit({
      [skillFilePath("recon")]: serializeSkillFile(skill("recon")),
      [`${folder}/references/ledger.md`]: "# Ledger\n",
      [`${folder}/scripts/backfill.sql`]: "select 1;\n",
      [`${folder}/resources/sub/rates.csv`]: "ccy,rate\nCHF,1\n",
      [`${folder}/scripts/logo.png`]: "not really a png",
      [`${folder}/scripts/big.sql`]: "x".repeat(MAX_SKILL_RESOURCE_BYTES + 1),
      [`${folder}/scripts/nul.sql`]: "select 1;\u0000\n",
      // Not under a resource folder: not a resource.
      [`${folder}/notes.md`]: "scratch\n",
      [skillFilePath("secret")]: serializeSkillFile(
        skill("secret", "Another skill's body."),
      ),
      [`skills/secret/references/private.md`]: "other skill\n",
      "PROMPT.md": "workspace prompt\n",
    });
  }

  it("lists the served files with their size, and the refused ones as warnings", async () => {
    await seed();
    const catalog = await loadSkillCatalog(WS);
    const recon = catalog.skills.find(s => s.name === "recon")!;
    expect(recon.resources).toEqual([
      { path: "references/ledger.md", size: 9 },
      { path: "resources/sub/rates.csv", size: 15 },
      { path: "scripts/backfill.sql", size: 10 },
      { path: "scripts/nul.sql", size: 11 },
    ]);
    expect(catalog.warnings.map(w => [w.path, w.reason])).toEqual([
      [
        "skills/recon/scripts/big.sql",
        "resource not served: file 64,001 bytes over the 64,000 limit",
      ],
      [
        "skills/recon/scripts/logo.png",
        expect.stringMatching(
          /^resource not served: "\.png" files are not served \(text only: \.md /,
        ),
      ],
    ]);
  });

  it("reads a listed file and nothing else", async () => {
    await seed();
    const recon = (await findSkill(WS, "recon"))!;
    expect(
      await readWorkspaceSkillResource(WS, recon, "scripts/backfill.sql"),
    ).toEqual({
      success: true,
      skill: "recon",
      path: "scripts/backfill.sql",
      content: "select 1;\n",
      size: 10,
      references: [
        "references/ledger.md",
        "resources/sub/rates.csv",
        "scripts/backfill.sql",
        "scripts/nul.sql",
      ],
    });
    expect(
      await readWorkspaceSkillResource(WS, recon, "resources/sub/rates.csv"),
    ).toMatchObject({ success: true, content: "ccy,rate\nCHF,1\n" });

    const refused = async (relPath: string) => {
      const read = await readWorkspaceSkillResource(WS, recon, relPath);
      expect(read.success, relPath).toBe(false);
      return read.success ? "" : read.error;
    };
    expect(await refused("scripts/logo.png")).toMatch(
      /is not served: "\.png" files are not served/,
    );
    expect(await refused("scripts/big.sql")).toMatch(
      /is not served: file 64,001 bytes over the 64,000 limit/,
    );
    expect(await refused("scripts/nul.sql")).toMatch(/binary file/);
    expect(await refused("notes.md")).toMatch(
      /live under references\/, scripts\/, resources\//,
    );
    expect(await refused("references/missing.md")).toMatch(
      /not found for skill "recon"\. Available: references\/ledger\.md/,
    );
  });

  it("cannot be walked out of the skill folder", async () => {
    await seed();
    const recon = (await findSkill(WS, "recon"))!;
    for (const attempt of [
      "../secret/SKILL.md",
      "../secret/references/private.md",
      "references/../../secret/references/private.md",
      "references/../../../PROMPT.md",
      "scripts/../SKILL.md",
      "references/./ledger.md",
      "references//ledger.md",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "references\\..\\..\\secret\\SKILL.md",
      "references/ledger.md\u0000.png",
      "scripts/%2e%2e/%2e%2e/secret/SKILL.md",
      "SKILL.md",
      "",
    ]) {
      const read = await readWorkspaceSkillResource(WS, recon, attempt);
      expect(read.success, JSON.stringify(attempt)).toBe(false);
      expect(JSON.stringify(read), JSON.stringify(attempt)).not.toMatch(
        /other skill|Another skill|workspace prompt/,
      );
    }
    // The path rule on its own: only plain segments under a resource folder.
    expect(normalizeSkillResourcePath("references/a/b.md")).toEqual({
      ok: true,
      path: "references/a/b.md",
    });
    expect(normalizeSkillResourcePath("references/../x.md").ok).toBe(false);
  });

  it("refuses links and caps the number of files per skill", () => {
    const many = Array.from(
      { length: MAX_SKILL_RESOURCES_PER_SKILL + 2 },
      (_, i) => ({
        path: `references/r${String(i).padStart(3, "0")}.md`,
        size: 10,
        mode: "100644",
      }),
    );
    const sorted = classifySkillResources([
      ...many,
      { path: "scripts/link.sh", size: 12, mode: "120000" },
      { path: "scripts/Makefile", size: 12, mode: "100644" },
      { path: "elsewhere/x.md", size: 12, mode: "100644" },
    ]);
    expect(sorted.resources).toHaveLength(MAX_SKILL_RESOURCES_PER_SKILL);
    expect(sorted.refused.map(file => [file.path, file.reason])).toEqual([
      ["references/r040.md", "over the 40 resource files per skill limit"],
      ["references/r041.md", "over the 40 resource files per skill limit"],
      [
        "scripts/Makefile",
        expect.stringMatching(/^files with no extension are not served/),
      ],
      ["scripts/link.sh", "symbolic links are not served"],
    ]);
  });
});
