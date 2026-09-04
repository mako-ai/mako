/**
 * Skills are files at main (apps.md §27): real bare repos under a temp
 * APPS_GIT_ROOT, no Mongo, no network. mongodb-memory-server is started only
 * because the workspace-repo binding helpers read the Workspace model.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  SKILLS_README_PATH,
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
} from "./skill-files";
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
  loadSkillCatalog,
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
