/**
 * Skills served whole from the files at main (apps.md §27): the prompt
 * index carries every offered skill, pinned skills carry their body,
 * search is a keyword match, proposals start suppressed. Same rig as
 * workspace-skills.service.test.ts.
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
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { serializeSkillFile, skillFilePath } from "../apps/skill-files";
import { invalidateSkillCatalog } from "../apps/workspace-skills.service";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { createSkillTools } from "../agent-lib/tools/skill-tools";
import { SkillUsageDaily } from "../database/workspace-schema";
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

  it("accepts hyphenated names; refuses a second spelling of an existing one; load_skill finds either", async () => {
    const saved = await saveSkill(WS, input("app-ui-conventions"), "u1");
    expect(saved).toMatchObject({ success: true, skill: { created: true } });
    expect(await fileAt(skillFilePath("app-ui-conventions"))).toContain(
      "name: app-ui-conventions",
    );

    const twin = await saveSkill(WS, input("app_ui_conventions"), "u1");
    expect(twin).toMatchObject({ success: false });
    expect((twin as { error: string }).error).toMatch(
      /"app-ui-conventions" already exists/,
    );

    for (const spelling of ["app-ui-conventions", "app_ui_conventions"]) {
      const loaded = await loadSkill(WS, spelling);
      expect(loaded).toMatchObject({
        success: true,
        skill: { name: "app-ui-conventions" },
      });
    }

    for (const bad of ["-lead", "Upper", "a.b", "../x", "a/b", "a b"]) {
      const result = await saveSkill(WS, input(bad), "u1");
      expect(result, bad).toMatchObject({ success: false });
      expect((result as { error: string }).error).toMatch(/name must be/);
    }
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
    expect(block).toContain("#### Pinned skill excerpts (budgeted)");
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

  it("finds system skills too, with the workspace's own first on a tie", async () => {
    const hits = await searchSkills(WS, "workflow cron webhook slack", 3);
    expect(hits[0]).toMatchObject({ name: "workflows", scope: "system" });
    expect(hits[0]!.body).toContain("# Workflows");

    // A workspace skill of the same name is the one load_skill serves.
    await saveSkill(
      WS,
      {
        name: "workflows",
        loadWhen: "our workflow cron webhook slack rules",
        body: "Ours.",
      },
      "u1",
    );
    const shadowed = await searchSkills(WS, "workflow cron webhook slack", 3);
    expect(shadowed.filter(h => h.name === "workflows")).toEqual([
      expect.objectContaining({ scope: "workspace", body: "Ours." }),
    ]);
  });

  it("a system skill matches only on what it says it is for, never on stopwords", async () => {
    // Long system bodies mention "the", "for" and most business words.
    expect(await searchSkills(WS, "the")).toEqual([]);
    const unrelated = await searchSkills(
      WS,
      "churn definition for our customers",
    );
    expect(unrelated.filter(h => h.scope === "system")).toEqual([]);

    // A workspace skill matching in its description still makes the top 3.
    await saveSkill(
      WS,
      {
        name: "revenue_watch",
        loadWhen: "when revenue numbers move",
        body: "Look at the finance mart first.",
      },
      "u1",
    );
    const hits = await searchSkills(
      WS,
      "send slack alert when revenue drops",
      3,
    );
    expect(hits.map(h => h.name)).toContain("revenue_watch");
    expect(hits[0]).toMatchObject({ name: "workflows", scope: "system" });
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
        "no front matter: the file must start with a `---` block that holds `description`",
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

  it("list_skills names the files that never reach the index, with why", async () => {
    await saveSkill(WS, input("fine"), "u1");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "skills/Bad_Name/SKILL.md": "x\n" } },
      { message: "laptop" },
    );
    const tools = createSkillTools(WS, "u1");
    const result = (await tools.list_skills.execute!({}, {
      toolCallId: "t",
      messages: [],
    } as never)) as {
      skills: { name: string }[];
      invalid?: { name: string; reason: string }[];
    };
    expect(result.skills.some(s => s.name === "fine")).toBe(true);
    expect(result.invalid).toEqual([
      {
        name: "Bad_Name",
        path: "skills/Bad_Name/SKILL.md",
        reason: expect.stringMatching(/folder name must be lowercase/),
      },
    ]);
  });
});

describe("skill tools: hidden files, resources, usage", () => {
  const ctx = { toolCallId: "t", messages: [] } as never;
  const run = async <T>(
    tool: { execute?: (input: never, options: never) => unknown },
    args: unknown,
  ): Promise<T> => (await tool.execute!(args as never, ctx)) as T;

  /** Background usage writes settle: `rows` rows hold `total` counts. */
  async function usageRows(total: number) {
    return vi.waitFor(async () => {
      const rows = await SkillUsageDaily.find({}).lean();
      const sum = rows.reduce(
        (n, row) =>
          n +
          (row.loads ?? 0) +
          (row.resourceReads ?? 0) +
          (row.relevantHits ?? 0),
        0,
      );
      expect(sum).toBe(total);
      return rows;
    });
  }

  beforeAll(async () => {
    await SkillUsageDaily.syncIndexes();
  });

  beforeEach(async () => {
    await SkillUsageDaily.deleteMany({});
    await saveSkill(WS, input("recon", "Reconcile the ledger."), "u1");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "skills/recon/references/ledger.md": "# Ledger\n",
          "skills/recon/scripts/backfill.sql": "select 1;\n",
          "skills/recon/scripts/logo.png": "png",
          // 24,713 characters of body: over the 20,000 limit.
          [skillFilePath("glossary")]: serializeSkillFile({
            name: "glossary",
            loadWhen: "any business term",
            entities: [],
            suppressed: false,
            pinned: false,
            body: "x".repeat(24_713),
          }),
          [skillFilePath("wordy")]: serializeSkillFile({
            name: "wordy",
            loadWhen: "Load when asked about revenue. ".repeat(8).trim(),
            entities: [],
            suppressed: false,
            pinned: false,
            body: "Short body.",
          }),
        },
      },
      { message: "laptop" },
    );
    invalidateSkillCatalog(WS);
  });

  it("list_skills reports hidden files, warnings and usage beside the unchanged index", async () => {
    const tools = createSkillTools(WS, "u1");
    type Listing = {
      success: true;
      skills: Array<{
        name: string;
        loadWhen: string;
        scope: string;
        loads30d: number;
        lastLoadedAt: string | null;
      }>;
      invalid?: Array<{ name: string; path: string; reason: string }>;
      invalidNote?: string;
      warnings?: Array<{ name: string; path: string; reason: string }>;
    };
    const before = await run<Listing>(tools.list_skills, {});
    expect(before.invalid).toEqual([
      {
        name: "glossary",
        path: "skills/glossary/SKILL.md",
        reason: "body 24,713 chars over the 20,000 limit",
      },
    ]);
    expect(before.invalidNote).toMatch(/NOT in the index/);
    expect(before.warnings).toEqual([
      {
        name: "recon",
        path: "skills/recon/scripts/logo.png",
        reason: expect.stringMatching(/^resource not served: "\.png" files/),
      },
      {
        name: "wordy",
        path: "skills/wordy/SKILL.md",
        reason: "description 247 chars: the index shows the first 200",
      },
    ]);
    expect(before.skills.find(s => s.name === "glossary")).toBeUndefined();
    expect(before.skills.find(s => s.name === "recon")).toEqual({
      name: "recon",
      loadWhen: "when asked about recon",
      scope: "workspace",
      loads30d: 0,
      lastLoadedAt: null,
    });

    await run(tools.load_skill, { name: "recon" });
    await run(tools.load_skill, { name: "recon" });
    await run(tools.read_skill_resource, {
      name: "recon",
      path: "scripts/backfill.sql",
    });
    await run(tools.load_skill, { name: "apps" });
    await run(tools.load_skill, { name: "no_such_skill" });
    await usageRows(4);

    const after = await run<Listing>(tools.list_skills, {});
    const recon = after.skills.find(s => s.name === "recon")!;
    expect(recon.loads30d).toBe(3);
    expect(Date.parse(recon.lastLoadedAt!)).toBeGreaterThan(
      Date.now() - 60_000,
    );
    expect(after.skills.find(s => s.name === "apps")).toMatchObject({
      scope: "system",
      loads30d: 1,
    });
    expect(after.skills.find(s => s.name === "wordy")).toMatchObject({
      loads30d: 0,
      lastLoadedAt: null,
    });
  });

  it("counts each read once, by source and day, and nothing on a failed read", async () => {
    const agent = createSkillTools(WS, "u1");
    const mcp = createSkillTools(WS, "u1", { source: "mcp" });
    await run(agent.load_skill, { name: "recon" });
    await run(mcp.load_skill, { name: "recon" });
    await run(mcp.read_skill_resource, {
      name: "recon",
      path: "references/ledger.md",
    });
    await run(mcp.read_skill_resource, {
      name: "recon",
      path: "../glossary/SKILL.md",
    });
    const relevant = await run<{ relevant: Array<{ name: string }> }>(
      agent.get_relevant_skills,
      { query: "recon ledger" },
    );
    expect(relevant.relevant.map(hit => hit.name)).toEqual(["recon"]);

    const rows = await usageRows(4);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      rows
        .map(row => ({
          skill: row.skill,
          scope: row.scope,
          source: row.source,
          day: row.day,
          loads: row.loads ?? 0,
          resourceReads: row.resourceReads ?? 0,
          relevantHits: row.relevantHits ?? 0,
        }))
        .sort((a, b) => a.source.localeCompare(b.source)),
    ).toEqual([
      {
        skill: "recon",
        scope: "workspace",
        source: "agent",
        day: today,
        loads: 1,
        resourceReads: 0,
        relevantHits: 1,
      },
      {
        skill: "recon",
        scope: "workspace",
        source: "mcp",
        day: today,
        loads: 1,
        resourceReads: 1,
        relevantHits: 0,
      },
    ]);
  });

  it("a load still answers when the usage write fails", async () => {
    const write = vi
      .spyOn(SkillUsageDaily, "bulkWrite")
      .mockRejectedValue(new Error("mongo is down"));
    try {
      const tools = createSkillTools(WS, "u1");
      const loaded = await run<{ success: boolean; skill: { body: string } }>(
        tools.load_skill,
        { name: "recon" },
      );
      expect(loaded.success).toBe(true);
      expect(loaded.skill.body).toBe("Reconcile the ledger.");
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
    } finally {
      write.mockRestore();
    }
  });

  it("load_skill lists the skill's resources; read_skill_resource serves workspace and system files", async () => {
    const tools = createSkillTools(WS, "u1");
    const loaded = await run<{
      success: true;
      skill: {
        name: string;
        body: string;
        suppressed: boolean;
        pinned: boolean;
        resources: Array<{ path: string; size: number }>;
      };
    }>(tools.load_skill, { name: "recon" });
    expect(loaded.skill).toMatchObject({
      name: "recon",
      body: "Reconcile the ledger.",
      suppressed: false,
      pinned: false,
      resources: [
        { path: "references/ledger.md", size: 9 },
        { path: "scripts/backfill.sql", size: 10 },
      ],
    });

    expect(
      await run(tools.read_skill_resource, {
        name: "recon",
        path: "scripts/backfill.sql",
      }),
    ).toEqual({
      success: true,
      skill: "recon",
      scope: "workspace",
      path: "scripts/backfill.sql",
      content: "select 1;\n",
      size: 10,
      references: ["references/ledger.md", "scripts/backfill.sql"],
    });
    for (const attempt of [
      "../glossary/SKILL.md",
      "references/../../wordy/SKILL.md",
      "/etc/passwd",
      "scripts/logo.png",
    ]) {
      expect(
        await run<{ success: boolean }>(tools.read_skill_resource, {
          name: "recon",
          path: attempt,
        }),
        attempt,
      ).toMatchObject({ success: false });
    }

    const system = await run<{
      success: boolean;
      scope: string;
      content: string;
    }>(tools.read_skill_resource, {
      name: "apps",
      path: "references/charting.md",
    });
    expect(system).toMatchObject({ success: true, scope: "system" });
    expect(system.content.length).toBeGreaterThan(100);
    const apps = await run<{
      skill: { resources: Array<{ path: string; size: number }> };
    }>(tools.load_skill, { name: "apps" });
    expect(apps.skill.resources.map(r => r.path)).toContain(
      "references/charting.md",
    );
    expect(apps.skill.resources.every(r => r.size > 0)).toBe(true);
    expect(
      await run(tools.read_skill_resource, {
        name: "no_such_skill",
        path: "references/a.md",
      }),
    ).toEqual({ success: false, error: 'skill "no_such_skill" not found' });
  });

  it("a workspace skill named like a system one keeps the system references readable", async () => {
    await saveSkill(WS, input("apps", "Our own app rules."), "u1");
    const tools = createSkillTools(WS, "u1");
    expect(
      await run(tools.read_skill_resource, {
        name: "apps",
        path: "references/charting.md",
      }),
    ).toMatchObject({ success: true, scope: "system", skill: "apps" });
    expect(
      await run(tools.read_skill_resource, {
        name: "apps",
        path: "references/../SKILL.md",
      }),
    ).toMatchObject({ success: false });
  });

  it("get_relevant_skills says when the query names a hidden skill", async () => {
    const tools = createSkillTools(WS, "u1");
    type Relevant = {
      relevant: Array<{ name: string }>;
      invalid?: Array<{ name: string; path: string; reason: string }>;
      notice?: string;
    };
    const hit = await run<Relevant>(tools.get_relevant_skills, {
      query: "glossary of business terms",
    });
    expect(hit.invalid).toEqual([
      {
        name: "glossary",
        path: "skills/glossary/SKILL.md",
        reason: "body 24,713 chars over the 20,000 limit",
      },
    ]);
    expect(hit.notice).toBe(
      "1 skill file matches this query by name but is hidden from the agent: skills/glossary/SKILL.md (body 24,713 chars over the 20,000 limit). Tell the user and name the fix.",
    );
    expect(hit.relevant.map(r => r.name)).not.toContain("glossary");

    const miss = await run<Relevant>(tools.get_relevant_skills, {
      query: "recon ledger",
    });
    expect(miss.invalid).toBeUndefined();
    expect(miss.notice).toBeUndefined();
    const searched = await run<Relevant>(tools.search_skills, {
      query: "glossary",
    });
    expect(searched.notice).toMatch(/skills\/glossary\/SKILL\.md/);
  });

  it("the admin list carries warnings, resources and usage", async () => {
    const tools = createSkillTools(WS, "u1");
    await run(tools.load_skill, { name: "recon" });
    await usageRows(1);
    const list = await listSkillsForAdmin(WS);
    expect(list.find(s => s.name === "recon")).toMatchObject({
      definitionInvalid: null,
      warnings: [
        expect.stringMatching(
          /^skills\/recon\/scripts\/logo\.png: resource not served/,
        ),
      ],
      resources: [
        { path: "references/ledger.md", size: 9 },
        { path: "scripts/backfill.sql", size: 10 },
      ],
      loads30d: 1,
    });
    expect(list.find(s => s.name === "wordy")?.warnings).toEqual([
      "description 247 chars: the index shows the first 200",
    ]);
    expect(list.find(s => s.name === "glossary")).toMatchObject({
      definitionInvalid: {
        path: "skills/glossary/SKILL.md",
        reason: "body 24,713 chars over the 20,000 limit",
      },
      warnings: [],
      loads30d: 0,
      lastLoadedAt: null,
    });
  });
});
