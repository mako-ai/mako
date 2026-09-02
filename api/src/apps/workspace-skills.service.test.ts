/**
 * Skills in git (apps.md §10 Block D1): real bare repos under a temp
 * APPS_GIT_ROOT, mongodb-memory-server for the derived index, no network —
 * the same rig the consoles suite uses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Skill } from "../database/workspace-schema";
import {
  SKILLS_README_PATH,
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
} from "./skill-files";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  log,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import {
  adoptWorkspaceSkills,
  commitSkillDelete,
  commitSkillSave,
  commitSkillSuppressed,
  listSkillFilesFromRepo,
  syncSkillsIndexFromRepo,
} from "./workspace-skills.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-skills-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
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
  await Skill.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), MAIN, rel);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

const skill = (name: string, body = "Do the thing.") => ({
  name,
  loadWhen: `when asked about ${name}`,
  entities: [name],
  suppressed: false,
  body,
});

describe("format round-trip", () => {
  it("serializes and parses the SKILL.md package shape", () => {
    const file = serializeSkillFile(skill("mrr_walkthrough"));
    expect(file).toContain("description: when asked about mrr_walkthrough");
    const parsed = parseSkillFile("mrr_walkthrough", file);
    expect(parsed).toMatchObject({
      name: "mrr_walkthrough",
      loadWhen: "when asked about mrr_walkthrough",
      entities: ["mrr_walkthrough"],
      suppressed: false,
      body: "Do the thing.",
    });
  });
});

describe("write-through", () => {
  it("the first save adopts existing Mongo skills plus the marker", async () => {
    await Skill.create({
      workspaceId: new Types.ObjectId(WS),
      name: "legacy_skill",
      loadWhen: "legacy trigger",
      body: "Old knowledge.",
      entities: [],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: false,
      useCount: 3,
    });
    await commitSkillSave(WS, skill("fresh_skill"), {
      loadAdoptable: async () => [
        {
          name: "legacy_skill",
          loadWhen: "legacy trigger",
          entities: [],
          suppressed: false,
          body: "Old knowledge.",
        },
      ],
    });
    expect(await fileAt(SKILLS_README_PATH)).not.toBeNull();
    expect(await fileAt(skillFilePath("fresh_skill"))).toContain(
      "Do the thing.",
    );
    expect(await fileAt(skillFilePath("legacy_skill"))).toContain(
      "Old knowledge.",
    );
  });

  it("delete and suppress commit; a Mongo-only skill is a git no-op", async () => {
    await commitSkillSave(WS, skill("keeper"));
    expect(await commitSkillSuppressed(WS, "keeper", true)).toBe(true);
    expect(await fileAt(skillFilePath("keeper"))).toContain("suppressed: true");
    expect(await commitSkillDelete(WS, "keeper")).toBe(true);
    expect(await fileAt(skillFilePath("keeper"))).toBeNull();
    expect(await commitSkillDelete(WS, "never_committed")).toBe(false);
  });
});

describe("sync from repo", () => {
  it("an external skill edit reaches the index; removal deletes the row", async () => {
    await commitSkillSave(WS, skill("synced"));
    await syncSkillsIndexFromRepo(WS, "user-1");
    let row = await Skill.findOne({ name: "synced" });
    expect(row?.body).toBe("Do the thing.");

    // Laptop edit: change the body, keep telemetry.
    await Skill.updateOne({ _id: row!._id }, { $set: { useCount: 9 } });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          [skillFilePath("synced")]: serializeSkillFile(
            skill("synced", "Do the BETTER thing."),
          ),
        },
      },
      { message: "laptop edit" },
    );
    await syncSkillsIndexFromRepo(WS, "user-1");
    row = await Skill.findOne({ name: "synced" });
    expect(row?.body).toBe("Do the BETTER thing.");
    expect(row?.previousBody).toBe("Do the thing.");
    expect(row?.useCount).toBe(9);

    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: [skillFilePath("synced")] },
      { message: "laptop delete" },
    );
    await syncSkillsIndexFromRepo(WS, "user-1");
    expect(await Skill.findOne({ name: "synced" })).toBeNull();
  });

  it("never touches a workspace that has not adopted", async () => {
    await Skill.create({
      workspaceId: new Types.ObjectId(WS),
      name: "mongo_only",
      loadWhen: "trigger",
      body: "body",
      entities: [],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: false,
      useCount: 0,
    });
    const { initRepo } = await import("./repository.service");
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await syncSkillsIndexFromRepo(WS);
    expect(await Skill.findOne({ name: "mongo_only" })).not.toBeNull();
  });
});

describe("adoption (migration path)", () => {
  it("writes missing files + marker once, is re-runnable", async () => {
    for (const name of ["a_skill", "b_skill"]) {
      await Skill.create({
        workspaceId: new Types.ObjectId(WS),
        name,
        loadWhen: `use ${name}`,
        body: `${name} body`,
        entities: [],
        scopeType: "workspace",
        createdBy: "agent",
        suppressed: false,
        useCount: 0,
      });
    }
    const first = await adoptWorkspaceSkills(WS);
    expect(first).toMatchObject({ skills: 2, written: 3, adopted: true });
    expect((await listSkillFilesFromRepo(WS)).map(f => f.name).sort()).toEqual([
      "a_skill",
      "b_skill",
    ]);
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    const again = await adoptWorkspaceSkills(WS);
    expect(again.written).toBe(0);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect((await log(repoDirFor(WS), MAIN, 5))[0].subject).toContain(
      "Adopt workspace skills",
    );
  });

  it("writes the DECLARED entities to the file, never the derived index", async () => {
    // A row as the extractor leaves it: the author declared one entity, the
    // index holds that plus every tokenised body word.
    await Skill.create({
      workspaceId: new Types.ObjectId(WS),
      name: "mrr_rules",
      loadWhen: "MRR questions",
      body: "MRR is working already; null months are pending.",
      declaredEntities: ["mrr"],
      entities: ["mrr", "working", "already", "null", "months", "pending"],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: false,
      useCount: 0,
    });
    // A row from before `declaredEntities` existed: nothing was declared.
    await Skill.create({
      workspaceId: new Types.ObjectId(WS),
      name: "legacy_rules",
      loadWhen: "legacy questions",
      body: "Legacy body with several tokenised words.",
      entities: ["legacy", "body", "several", "tokenised", "words"],
      scopeType: "workspace",
      createdBy: "agent",
      suppressed: false,
      useCount: 0,
    });
    await adoptWorkspaceSkills(WS);

    const declared = parseSkillFile(
      "mrr_rules",
      (await fileAt(skillFilePath("mrr_rules"))) ?? "",
    );
    expect(declared?.entities).toEqual(["mrr"]);
    const legacy = await fileAt(skillFilePath("legacy_rules"));
    expect(legacy).not.toContain("entities:");
  });
});

describe("index sync keeps declared and derived apart", () => {
  it("stores the file's list as declaredEntities and the union as entities", async () => {
    await commitSkillSave(WS, {
      ...skill("feed_rules", "Offers come from lead_agents rows."),
      entities: ["feed"],
    });
    await syncSkillsIndexFromRepo(WS, "user-1");
    const row = await Skill.findOne({ name: "feed_rules" });
    expect(row?.declaredEntities).toEqual(["feed"]);
    expect(row?.entities).toEqual(
      expect.arrayContaining(["feed", "lead_agents"]),
    );
    expect(row?.entities.length ?? 0).toBeGreaterThan(1);
  });
});
