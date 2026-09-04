/**
 * Skills served whole from the files at main (apps.md §27): the prompt
 * index carries every offered skill, pinned skills carry their body,
 * search is a keyword match, proposals start suppressed. Same rig as
 * workspace-skills.service.test.ts.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { serializeSkillFile, skillFilePath } from "../apps/skill-files";
import { invalidateSkillCatalog } from "../apps/workspace-skills.service";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import {
  INDEX_DESCRIPTION_CHARS,
  deleteSkill,
  getSkillForAdmin,
  listSkillsForAdmin,
  loadSkill,
  renderSkillsPromptBlock,
  retrieveRelevantSkills,
  saveSkill,
  searchSkills,
  setSkillPinned,
  toggleSkillSuppressed,
} from "./skills.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skills-service-test-"));
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

beforeEach(async () => {
  invalidateSkillCatalog(WS);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function fileAt(rel: string): Promise<string> {
  return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
}

const input = (name: string, body = "Do the thing.") => ({
  name,
  loadWhen: `when asked about ${name}`,
  body,
  entities: [name],
});

describe("saves", () => {
  it("an agent's NEW skill is a proposal (suppressed in the file); a user's is live; updates keep flags", async () => {
    const proposed = await saveSkill(WS, input("proposal"), "agent", {
      origin: "agent",
    });
    expect(proposed).toMatchObject({
      success: true,
      skill: { created: true, pendingApproval: true },
    });
    expect(await fileAt(skillFilePath("proposal"))).toContain(
      "suppressed: true",
    );
    const live = await saveSkill(WS, input("live"), "u1");
    expect(live).toMatchObject({ success: true, skill: { created: true } });
    expect(await fileAt(skillFilePath("live"))).not.toContain("suppressed");

    await setSkillPinned(
      WS,
      (live as { skill: { id: string } }).skill.id,
      true,
    );
    const updated = await saveSkill(WS, input("live", "v2"), "agent", {
      origin: "agent",
    });
    expect(updated).toMatchObject({ success: true, skill: { created: false } });
    const file = await fileAt(skillFilePath("live"));
    expect(file).toContain("pinned: true");
    expect(file).toContain("v2");
    expect(file).not.toContain("suppressed");
  });

  it("rejects a description that would not fit the index", async () => {
    const result = await saveSkill(
      WS,
      { ...input("long"), loadWhen: "x".repeat(301) },
      "u1",
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toMatch(/loadWhen exceeds/);
  });
});

describe("the prompt gets the whole index and the pinned bodies", () => {
  it("lists every offered skill, cuts long descriptions, injects pinned bodies only", async () => {
    await saveSkill(WS, input("alpha"), "u1");
    await saveSkill(WS, { ...input("pinned_one"), pinned: true }, "u1");
    await saveSkill(WS, input("hidden"), "agent", { origin: "agent" });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          [skillFilePath("verbose")]: serializeSkillFile({
            name: "verbose",
            loadWhen: "v".repeat(INDEX_DESCRIPTION_CHARS + 50),
            entities: [],
            suppressed: false,
            pinned: false,
            body: "Long-winded.",
          }),
        },
      },
      { message: "laptop" },
    );
    const result = await retrieveRelevantSkills(WS);
    const workspace = result.index.filter(s => s.scope === "workspace");
    expect(workspace.map(s => s.name)).toEqual([
      "alpha",
      "pinned_one",
      "verbose",
    ]);
    const verbose = workspace.find(s => s.name === "verbose")!;
    expect(verbose.loadWhen.length).toBe(INDEX_DESCRIPTION_CHARS);
    expect(verbose.loadWhen.endsWith("…")).toBe(true);
    expect(result.injected.map(s => s.name)).toEqual(["pinned_one"]);
    expect(result.injected[0]!.body).toBe("Do the thing.");

    const block = renderSkillsPromptBlock(result);
    expect(block).toContain("`alpha`: when asked about alpha");
    expect(block).toContain("`pinned_one` (pinned)");
    expect(block).toContain("#### Pinned skills (always loaded)");
    expect(block).not.toContain("hidden");
    expect(block).not.toContain("retrieval trace");
  });

  it("a suppressed skill can still be loaded by name; a system skill loads too", async () => {
    await saveSkill(WS, input("hidden"), "agent", { origin: "agent" });
    const loaded = await loadSkill(WS, "hidden");
    expect(loaded).toMatchObject({
      success: true,
      skill: { name: "hidden", suppressed: true },
    });
    expect(await loadSkill(WS, "definitely_not_a_skill")).toMatchObject({
      success: false,
    });
  });
});

describe("search is a keyword match over the catalog", () => {
  it("ranks name and description hits above body hits; suppressed skills never match", async () => {
    await saveSkill(
      WS,
      { ...input("mrr_walkthrough"), body: "How MRR is computed." },
      "u1",
    );
    await saveSkill(
      WS,
      {
        name: "churn_playbook",
        loadWhen: "when asked about churn",
        body: "Mentions mrr once in passing.",
      },
      "u1",
    );
    await saveSkill(WS, { ...input("mrr_secret") }, "agent", {
      origin: "agent",
    });
    const hits = await searchSkills(WS, "mrr");
    expect(hits.map(h => h.name)).toEqual([
      "mrr_walkthrough",
      "churn_playbook",
    ]);
    expect(hits[0]!.body).toBe("How MRR is computed.");
    expect(await searchSkills(WS, "")).toEqual([]);
  });
});

describe("admin surface", () => {
  it("lists valid skills then invalid files with a reason; toggles and deletes commit", async () => {
    await saveSkill(WS, input("fine"), "u1");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { [skillFilePath("broken")]: "nope\n" } },
      { message: "laptop" },
    );
    const list = await listSkillsForAdmin(WS);
    expect(
      list.map(s => [s.name, s.definitionInvalid?.reason ?? null]),
    ).toEqual([
      ["fine", null],
      [
        "broken",
        "unparseable skill file (frontmatter with `description` and a body are required)",
      ],
    ]);
    const fine = list[0]!;
    expect(await getSkillForAdmin(WS, fine.id)).toMatchObject({
      name: "fine",
      body: "Do the thing.",
      path: skillFilePath("fine"),
    });
    expect(await toggleSkillSuppressed(WS, fine.id, true, "u1")).toBe(true);
    expect((await getSkillForAdmin(WS, fine.id))?.suppressed).toBe(true);
    expect(await deleteSkill(WS, "fine", "u1")).toEqual({
      success: true,
      deleted: true,
    });
    expect(await getSkillForAdmin(WS, fine.id)).toBeNull();
    expect(await getSkillForAdmin(WS, list[1]!.id)).toBeNull();
  });
});
