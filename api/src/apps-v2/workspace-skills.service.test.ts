/**
 * Workspace skills in git — integration tests. Real git repos under a temp
 * APPS_V2_GIT_ROOT, mongodb-memory-server for the derived index, and no
 * embedding key so the vector-free path runs (the one CI exercises).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Skill } from "../database/workspace-schema";
import {
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
  skillNameFromPath,
} from "./skill-files";
import { workspaceSeedFiles } from "./workspace-template";
import {
  commitSkillDelete,
  commitSkillSave,
  commitSkillSuppressed,
  listSkillFilesFromRepo,
  syncSkillsIndexFromRepo,
} from "./workspace-skills.service";
import {
  initRepo,
  readBlob,
  repoDirFor,
  repoExists,
} from "./repository.service";
import { deleteSkill, saveSkill } from "../services/skills.service";
import { up as skillsToGitMigration } from "../migrations/2026-08-30-120000_workspace_skills_to_git";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-v2-skills-test-"));
  process.env.APPS_V2_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_V2_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  // Hermetic: no embeddings, no cloud mirror.
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.MAKO_CLOUD_GITHUB_ORG;
  delete process.env.MAKO_CLOUD_GITHUB_APP_ID;
  delete process.env.MAKO_CLOUD_GITHUB_APP_PRIVATE_KEY;

  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await Skill.deleteMany({});
});

async function fileAtMain(ws: string, rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(ws), "refs/heads/main", rel);
    return blob.contents;
  } catch {
    return null;
  }
}

describe("skill-files format", () => {
  it("round-trips name, trigger, entities, suppressed and body", () => {
    const skill = {
      name: "mrr_walkthrough",
      loadWhen: 'Computing MRR — or answering "what is our revenue?"',
      entities: ["mrr", "revenue"],
      suppressed: true,
      body: "Line one.\n\n- bullet with `code`\n- another: value",
    };
    const parsed = parseSkillFile(skill.name, serializeSkillFile(skill));
    expect(parsed).toEqual(skill);
  });

  it("omits empty entities and false suppressed from frontmatter", () => {
    const text = serializeSkillFile({
      name: "plain",
      loadWhen: "trigger",
      entities: [],
      suppressed: false,
      body: "body",
    });
    expect(text).not.toContain("entities");
    expect(text).not.toContain("suppressed");
    expect(parseSkillFile("plain", text)).toMatchObject({
      suppressed: false,
      entities: [],
    });
  });

  it("rejects files without a trigger or body, and bad paths", () => {
    expect(parseSkillFile("x", "---\nname: x\n---\n\nbody")).toBeNull();
    expect(parseSkillFile("x", "no frontmatter at all")).toBeNull();
    expect(skillNameFromPath("skills/good_one/SKILL.md")).toBe("good_one");
    expect(skillNameFromPath("skills/Bad-Name/SKILL.md")).toBeNull();
    expect(skillNameFromPath("skills/nested/x/SKILL.md")).toBeNull();
    expect(skillNameFromPath("apps/foo/SKILL.md")).toBeNull();
  });
});

describe("commitSkillSave / delete / suppress", () => {
  it("initializes a fresh workspace repo with the starter template", async () => {
    const ws = new Types.ObjectId().toString();
    await commitSkillSave(ws, {
      name: "first_skill",
      loadWhen: "when testing",
      entities: [],
      suppressed: false,
      body: "the body",
    });
    expect(await repoExists(repoDirFor(ws))).toBe(true);
    expect(await fileAtMain(ws, "AGENTS.md")).toContain("Mako workspace");
    expect(await fileAtMain(ws, "skills/README.md")).toContain("SKILL.md");
    expect(await fileAtMain(ws, "packages/app-sdk/package.json")).toBeTruthy();
    expect(await fileAtMain(ws, skillFilePath("first_skill"))).toContain(
      "when testing",
    );
    // The suppressed example ships in the seed but a real skill list works.
    const files = await listSkillFilesFromRepo(ws);
    expect(files.map(f => f.name).sort()).toEqual([
      "example_skill",
      "first_skill",
    ]);
  });

  it("adopts pre-existing Mongo skills into the first commit", async () => {
    const ws = new Types.ObjectId().toString();
    // A repo that predates skills-in-git: initialized without the template.
    await initRepo(repoDirFor(ws), { "README.md": "old workspace\n" });
    await Skill.create({
      workspaceId: new Types.ObjectId(ws),
      name: "legacy_skill",
      loadWhen: "legacy trigger",
      body: "legacy body",
      entities: ["legacy"],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: false,
      useCount: 3,
    });
    await commitSkillSave(
      ws,
      {
        name: "new_skill",
        loadWhen: "new trigger",
        entities: [],
        suppressed: false,
        body: "new body",
      },
      {
        loadAdoptable: async () => [
          {
            name: "legacy_skill",
            loadWhen: "legacy trigger",
            entities: ["legacy"],
            suppressed: false,
            body: "legacy body",
          },
        ],
      },
    );
    expect(await fileAtMain(ws, skillFilePath("legacy_skill"))).toContain(
      "legacy body",
    );
    expect(await fileAtMain(ws, skillFilePath("new_skill"))).toContain(
      "new body",
    );
    // Template backfilled, README untouched.
    expect(await fileAtMain(ws, "README.md")).toBe("old workspace\n");
    expect(await fileAtMain(ws, "AGENTS.md")).toContain("Mako workspace");
  });

  it("deletes and suppresses via commits", async () => {
    const ws = new Types.ObjectId().toString();
    await commitSkillSave(ws, {
      name: "target",
      loadWhen: "t",
      entities: [],
      suppressed: false,
      body: "b",
    });
    expect(await commitSkillSuppressed(ws, "target", true)).toBe(true);
    expect(await fileAtMain(ws, skillFilePath("target"))).toContain(
      "suppressed: true",
    );
    expect(await commitSkillDelete(ws, "target")).toBe(true);
    expect(await fileAtMain(ws, skillFilePath("target"))).toBeNull();
    expect(await commitSkillDelete(ws, "target")).toBe(false);
    expect(await commitSkillDelete(ws, "not-a-valid-name")).toBe(false);
  });
});

describe("syncSkillsIndexFromRepo", () => {
  it("creates, updates and deletes index rows from repo state", async () => {
    const ws = new Types.ObjectId().toString();
    await commitSkillSave(ws, {
      name: "synced",
      loadWhen: "sync trigger",
      entities: ["alpha"],
      suppressed: false,
      body: "v1",
    });
    await syncSkillsIndexFromRepo(ws, "user-1");
    const row = await Skill.findOne({ name: "synced" });
    expect(row?.body).toBe("v1");
    expect(row?.entities).toContain("alpha");
    // The suppressed template example syncs too, as suppressed.
    const example = await Skill.findOne({ name: "example_skill" });
    expect(example?.suppressed).toBe(true);

    // Update body + trigger via a direct commit (simulating a git push),
    // preserving telemetry.
    await Skill.updateOne({ name: "synced" }, { $set: { useCount: 7 } });
    await commitSkillSave(ws, {
      name: "synced",
      loadWhen: "changed trigger",
      entities: ["alpha"],
      suppressed: false,
      body: "v2",
    });
    await syncSkillsIndexFromRepo(ws);
    const updated = await Skill.findOne({ name: "synced" });
    expect(updated?.body).toBe("v2");
    expect(updated?.loadWhen).toBe("changed trigger");
    expect(updated?.useCount).toBe(7);
    expect(updated?.previousBody).toBe("v1");

    // Deletion in git deletes the row.
    await commitSkillDelete(ws, "synced");
    await syncSkillsIndexFromRepo(ws);
    expect(await Skill.findOne({ name: "synced" })).toBeNull();
  });

  it("never touches Mongo for an unadopted repo", async () => {
    const ws = new Types.ObjectId().toString();
    await initRepo(repoDirFor(ws), { "README.md": "pre-template\n" });
    await Skill.create({
      workspaceId: new Types.ObjectId(ws),
      name: "mongo_only",
      loadWhen: "t",
      body: "b",
      scopeType: "workspace",
      createdBy: "agent",
    });
    await syncSkillsIndexFromRepo(ws);
    expect(await Skill.findOne({ name: "mongo_only" })).toBeTruthy();
  });
});

describe("skills.service write-through", () => {
  it("saveSkill commits to git and keeps the index row", async () => {
    const ws = new Types.ObjectId().toString();
    const res = await saveSkill(
      ws,
      {
        name: "service_skill",
        loadWhen: "service trigger",
        body: "service body",
      },
      "agent",
    );
    expect(res.success).toBe(true);
    expect(await fileAtMain(ws, skillFilePath("service_skill"))).toContain(
      "service body",
    );
    expect(await Skill.findOne({ name: "service_skill" })).toBeTruthy();

    const del = await deleteSkill(ws, "service_skill", "agent");
    expect(del).toEqual({ success: true, deleted: true });
    expect(await fileAtMain(ws, skillFilePath("service_skill"))).toBeNull();
    expect(await Skill.findOne({ name: "service_skill" })).toBeNull();
  });
});

describe("workspace_skills_to_git migration", () => {
  it("adopts Mongo skills and backfills the template", async () => {
    const wsWithSkills = new Types.ObjectId().toString();
    const wsRepoOnly = new Types.ObjectId().toString();
    await Skill.create({
      workspaceId: new Types.ObjectId(wsWithSkills),
      name: "migrated_skill",
      loadWhen: "migrated trigger",
      body: "migrated body",
      entities: ["mig"],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: true,
    });
    await initRepo(repoDirFor(wsRepoOnly), { "README.md": "apps only\n" });

    const db = mongoose.connection.db;
    if (!db) throw new Error("no db");
    await skillsToGitMigration(db as never);

    // Workspace with skills: repo initialized from seed, skill committed.
    const migrated = await fileAtMain(
      wsWithSkills,
      skillFilePath("migrated_skill"),
    );
    expect(migrated).toContain("migrated body");
    expect(migrated).toContain("suppressed: true");
    expect(await fileAtMain(wsWithSkills, "AGENTS.md")).toBeTruthy();
    // Mongo rows stay (they are the derived index now).
    expect(await Skill.findOne({ name: "migrated_skill" })).toBeTruthy();

    // Repo-only workspace: template backfill, existing files untouched.
    expect(await fileAtMain(wsRepoOnly, "AGENTS.md")).toBeTruthy();
    expect(await fileAtMain(wsRepoOnly, "skills/README.md")).toBeTruthy();
    expect(await fileAtMain(wsRepoOnly, "README.md")).toBe("apps only\n");

    // Idempotent: a second run commits nothing new and does not throw.
    await skillsToGitMigration(db as never);
    expect(
      await fileAtMain(wsWithSkills, skillFilePath("migrated_skill")),
    ).toBe(migrated);
  });

  it("seed file map stays parseable and safe", () => {
    const seed = workspaceSeedFiles();
    expect(Object.keys(seed)).toEqual(
      expect.arrayContaining([
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".gitignore",
        "skills/README.md",
        "skills/example_skill/SKILL.md",
      ]),
    );
    const example = parseSkillFile(
      "example_skill",
      seed["skills/example_skill/SKILL.md"],
    );
    expect(example?.suppressed).toBe(true);
  });
});
