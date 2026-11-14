/**
 * SCENARIOS: renaming workspace skills (kind `skill`).
 *
 * A skill is `skills/<name>/SKILL.md`; the folder name is its identity. A
 * rename moves the folder with everything in it and records the old name
 * in the front matter `aliases`, one commit on main. After it:
 *
 *   - `load_skill("old")` still answers, and so does a name only git
 *     history knows (a bare `git mv` pushed from a laptop);
 *   - a live name always beats an old one, an old name two skills claim
 *     resolves to neither, and only live (unsuppressed) skills compete;
 *   - a new skill saved under an old name takes it for good; an agent's
 *     proposal takes nothing until it is approved.
 *
 * Real bare repos (APPS_GIT_ROOT in a temp dir) and mongodb-memory-server.
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
import { Hono } from "hono";
import { skillNameError } from "@mako/schemas";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// A commit landing on main after a rename has read the folder and before
// it commits.
const race = vi.hoisted(() => ({
  beforeRename: null as null | (() => Promise<unknown>),
}));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      const hook = race.beforeRename;
      if (hook && args[3].message.startsWith("Rename skill")) {
        race.beforeRename = null;
        await hook();
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: "u1" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "member" })),
  },
}));

import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log as repoLog,
  readBlobsBatch,
  repoDirFor,
  writeBlobs,
  type BlobMutation,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  editSkillFrontMatter,
  parseSkillFile,
  serializeSkillFile,
} from "../../apps/skill-files";
import {
  invalidateSkillCatalog,
  loadSkillCatalog,
  skillId,
} from "../../apps/workspace-skills.service";
import { getSystemSkillIndex } from "../../agent-lib/skills/system-skills";
import { missingInputConditionalGrant } from "../../agent-lib/capabilities/runtime";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { objectRoutes } from "../../routes/objects";
import {
  deleteSkill,
  listSkillsForAdmin,
  loadSkill,
  readSkillResource,
  saveSkill,
  skillUsageForIndex,
  toggleSkillSuppressed,
} from "../../services/skills.service";
import { recordSkillUsageNow } from "../../services/skill-usage.service";
import { MAX_ALIASES } from "../alias-cap";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const ctx = () => ({ workspaceId: WS, userId: "u1", role: "member" });

const app = new Hono();
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-scenarios-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  // No mirror: the freshen before each write fails at once, on this machine.
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${tmpRoot}/no-mirror`;
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

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  race.beforeRename = null;
  await initRepo(repoDirFor(WS), { "README.md": "# workspace\n" });
  await bindTestWorkspaceRepo(WS);
});

// ── Fixtures ────────────────────────────────────────────────────────

/** A playbook long enough that git pairs a moved and edited copy. */
const body = (name: string) =>
  [
    `How we do ${name}: read the brief, then check every number against`,
    "the warehouse before writing anything down.",
    "",
    "1. Read the brief.",
    "2. Check the numbers.",
    "3. Write it up and cite the consoles you used.",
  ].join("\n");

async function seed(name: string, origin: "user" | "agent" = "user") {
  const saved = await saveSkill(
    WS,
    { name, loadWhen: `when asked about ${name}`, body: body(name) },
    "u1",
    { origin },
  );
  expect(saved).toMatchObject({ success: true });
}

/** A commit straight onto main, as a push from a laptop lands. */
async function push(mutation: BlobMutation) {
  await commitBlobsOnBranch(repoDirFor(WS), DEFAULT_BRANCH, mutation, {
    message: "a push",
    author: { name: "L", email: "l@example.com" },
  });
  invalidateSkillCatalog(WS);
}

/** `git mv skills/<from> skills/<to>`, the SKILL.md optionally rewritten. */
async function gitMv(from: string, to: string, skillMd?: string) {
  const moving = (await tree()).filter(([p]) =>
    p.startsWith(`skills/${from}/`),
  );
  await push({
    deletes: moving.map(([p]) => p),
    entries: moving
      .filter(([p]) => !(skillMd && p.endsWith("/SKILL.md")))
      .map(([p, mode, oid]) => ({
        path: p.replace(`skills/${from}/`, `skills/${to}/`),
        mode: mode as "100644",
        oid,
      })),
    writes: skillMd ? { [`skills/${to}/SKILL.md`]: skillMd } : {},
  });
}

async function tree(): Promise<Array<[string, string, string]>> {
  return (await listTree(repoDirFor(WS), DEFAULT_BRANCH)).map(e => [
    e.path,
    e.mode,
    e.oid,
  ]);
}
const paths = async () => (await tree()).map(([p]) => p);
async function rawAt(rel: string): Promise<Buffer | null> {
  const blobs = await readBlobsBatch(repoDirFor(WS), DEFAULT_BRANCH, [rel]);
  return blobs.get(rel) ?? null;
}
async function skillMd(name: string): Promise<string> {
  const raw = await rawAt(`skills/${name}/SKILL.md`);
  if (!raw) throw new Error(`no skills/${name}/SKILL.md at main`);
  return raw.toString("utf8");
}
const commits = async () =>
  (await repoLog(repoDirFor(WS), DEFAULT_BRANCH, 5000)).length;

const rename = (ref: string, to: string) =>
  renameObject(ctx(), "skill", { ref, slug: to });
/** The skill a name opens, as `load_skill` answers. */
async function loads(name: string): Promise<string | null> {
  const r = await loadSkill(WS, name);
  return r.success ? r.skill.name : null;
}
const resolves = async (ref: string) => {
  const r = await resolveObjectRef(ctx(), "skill", ref);
  return r ? `${r.current.slug} (${r.via})` : null;
};
const aliasesOf = async (name: string) =>
  (await loadSkillCatalog(WS)).skills.find(s => s.name === name)?.aliases ?? [];

function post(kind: string, payload: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/objects/${kind}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

// ── Entry points ────────────────────────────────────────────────────

describe("one commit, the whole folder, and the old name keeps working", () => {
  it("the Skills panel (POST /objects) and rename_object", async () => {
    await seed("mrr_walkthrough");
    // What a person adds from a clone: comments, keys Mako does not know,
    // an executable helper, a symlink.
    const written = (await skillMd("mrr_walkthrough")).replace(
      "---\nname: mrr_walkthrough\n",
      "---\n# reviewed by finance\nname: mrr_walkthrough\nlicense: MIT\nallowed-tools: [sql_execute_query]\n",
    );
    const [helper, link] = await writeBlobs(repoDirFor(WS), [
      "#!/bin/sh\necho ok\n",
      "SKILL.md",
    ]);
    await push({
      writes: {
        "skills/mrr_walkthrough/SKILL.md": written,
        "skills/mrr_walkthrough/references/notes.md": "notes\n",
      },
      entries: [
        { path: "skills/mrr_walkthrough/run.sh", oid: helper, mode: "100755" },
        { path: "skills/mrr_walkthrough/README", oid: link, mode: "120000" },
      ],
    });
    const before = await tree();
    const n = await commits();
    const oldId = skillId(WS, "mrr_walkthrough");

    // By id, as the panel does.
    const res = await post("skill", { ref: oldId, slug: "mrr-walkthrough-fr" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { result } = (await res.json()) as {
      result: { id: string; aliasesAdded: string[]; warnings: string[] };
    };
    expect(result).toMatchObject({
      id: skillId(WS, "mrr-walkthrough-fr"),
      aliasesAdded: ["mrr_walkthrough"],
    });
    expect(result.warnings.join(" ")).toMatch(/id changed/);
    expect(await commits()).toBe(n + 1);

    // Every file moved, with its blob and mode; only SKILL.md was edited,
    // and only its `name` and `aliases` lines.
    const moved = (p: string) =>
      p.replace("skills/mrr_walkthrough/", "skills/mrr-walkthrough-fr/");
    const after = await tree();
    expect(after.map(([p]) => p).sort()).toEqual(
      before.map(([p]) => moved(p)).sort(),
    );
    for (const [p, mode, oid] of before) {
      if (p.endsWith("/SKILL.md")) continue;
      expect(after).toContainEqual([moved(p), mode, oid]);
    }
    expect(await skillMd("mrr-walkthrough-fr")).toBe(
      written
        .replace("name: mrr_walkthrough", "name: mrr-walkthrough-fr")
        .replace("\n---\n", "\naliases: [mrr_walkthrough]\n---\n"),
    );

    // The old name and the old id still find it.
    expect(await loads("mrr_walkthrough")).toBe("mrr-walkthrough-fr");
    expect(await resolves("mrr_walkthrough")).toBe(
      "mrr-walkthrough-fr (alias)",
    );
    expect(await resolves(oldId)).toBe("mrr-walkthrough-fr (alias)");
    expect((await listSkillsForAdmin(WS))[0]).toMatchObject({
      name: "mrr-walkthrough-fr",
      aliases: ["mrr_walkthrough"],
    });

    // rename_object, by an OLD name; needs the git-write grant on agent
    // surfaces (rename-capabilities.ts).
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "skill" },
        new Set(),
      )?.grant,
    ).toBe("git-write");
    const tool = await (
      createRenameTools(WS, "u1").rename_object.execute as (
        i: Record<string, unknown>,
        o: unknown,
      ) => Promise<{ success: boolean; error?: string }>
    )(
      { kind: "skill", ref: "mrr_walkthrough", slug: "mrr" },
      { toolCallId: "t", messages: [] },
    );
    expect(tool.success, tool.error).toBe(true);
    expect(await commits()).toBe(n + 2);
    expect(await aliasesOf("mrr")).toEqual([
      "mrr_walkthrough",
      "mrr-walkthrough-fr",
    ]);
    for (const old of ["mrr_walkthrough", "mrr-walkthrough-fr", "mrr"]) {
      expect([old, await loads(old)]).toEqual([old, "mrr"]);
    }
  });

  it("a laptop git mv: with the alias written, and bare (git history alone)", async () => {
    await seed("alpha");
    const md = await skillMd("alpha");
    // With the front matter updated by hand.
    await gitMv(
      "alpha",
      "beta",
      md.replace("name: alpha\n", "name: beta\naliases:\n- alpha\n"),
    );
    expect(await resolves("alpha")).toBe("beta (alias)");
    // Bare: nothing in the file says it was ever `beta`.
    await gitMv("beta", "gamma");
    expect(await aliasesOf("gamma")).toEqual(["alpha"]);
    expect(await resolves("beta")).toBe("gamma (alias)");
    expect(await loads("beta")).toBe("gamma");
    // …and a name only history knows can be renamed through. The hand-
    // written zero-indent list is edited in place and still parses.
    const through = await rename("beta", "delta");
    expect(through.after.slug).toBe("delta");
    expect(await aliasesOf("delta")).toEqual(["alpha", "gamma"]);
    expect(await skillMd("delta")).toContain("aliases: [alpha, gamma]\n");
    expect(await loads("beta")).toBe("delta");

    // A name used again later cuts the history chain: `beta` is the new
    // skill's, and after that skill is deleted it is nobody's.
    await seed("beta");
    expect(await resolves("beta")).toBe("beta (current)");
    await deleteSkill(WS, "beta", "u1");
    expect(await resolves("beta")).toBeNull();
    expect(await loads("beta")).toBeNull();
  });
});

describe("what the folder carries: its files and its usage", () => {
  it("read_skill_resource answers to the old name; usage counts across the names", async () => {
    await seed("glossary");
    await push({ writes: { "skills/glossary/references/terms.md": "MRR\n" } });
    const asWorkspace = (skill: string) => [
      { skill, scope: "workspace" as const },
    ];
    await recordSkillUsageNow(WS, asWorkspace("glossary"), "load", "agent");
    await recordSkillUsageNow(WS, asWorkspace("glossary"), "resource", "mcp");

    expect(await rename("glossary", "glossary-v2")).toMatchObject({
      aliasesAdded: ["glossary"],
    });

    // The file moved with the folder, and the old name still opens it.
    for (const name of ["glossary", "glossary-v2"]) {
      expect(
        await readSkillResource(WS, name, "references/terms.md"),
      ).toMatchObject({
        success: true,
        skill: "glossary-v2",
        scope: "workspace",
        content: "MRR\n",
      });
    }

    // Reads recorded before the rename sit under the old name; the panel
    // and list_skills add them to the skill's count.
    await recordSkillUsageNow(WS, asWorkspace("glossary-v2"), "load", "agent");
    const usageOf = await skillUsageForIndex(WS);
    expect(usageOf?.("workspace", "glossary-v2").loads30d).toBe(3);
    expect(
      (await listSkillsForAdmin(WS)).find(s => s.name === "glossary-v2"),
    ).toMatchObject({ loads30d: 3 });

    // A new skill takes the old name for good: from then on the renamed
    // skill counts only its own reads.
    await seed("glossary");
    const listed = await listSkillsForAdmin(WS);
    expect(listed.find(s => s.name === "glossary-v2")).toMatchObject({
      aliases: [],
      loads30d: 1,
    });
  });
});

// ── Operations ──────────────────────────────────────────────────────

describe("operations and names", () => {
  it("slug or title; back and forth swaps the old names; what is taken is refused", async () => {
    await seed("a_skill");
    await seed("other");
    await renameObject(ctx(), "skill", { ref: "a_skill", title: "b_skill" });
    await renameObject(ctx(), "skill", {
      ref: "b_skill",
      slug: "c_skill",
      title: "c_skill",
    });
    expect(await aliasesOf("c_skill")).toEqual(["a_skill", "b_skill"]);
    // Back to one of its OWN old names: the two swap.
    await rename("c_skill", "a_skill");
    expect(await aliasesOf("a_skill")).toEqual(["b_skill", "c_skill"]);

    const n = await commits();
    await rename("other", "elsewhere"); // `other` is now elsewhere's old name
    for (const [ref, to, status, said] of [
      [
        "a_skill",
        "elsewhere",
        409,
        'A skill named "elsewhere" already exists.',
      ],
      ["elsewhere", "a-skill", 409, "differs from it only in '-' vs '_'"],
      ["a_skill", "other", 409, 'a previous name of the skill "elsewhere"'],
      ["nope", "x", 404, 'skill "nope" not found'],
    ] as const) {
      const outcome = await rename(ref, to).then(
        () => "renamed",
        (e: { status?: number; message: string }) => [e.status, e.message],
      );
      expect([to, outcome]).toEqual([
        to,
        [status, expect.stringContaining(said)],
      ]);
    }
    // A title that contradicts the slug, and a rename to its own name.
    await expect(
      renameObject(ctx(), "skill", { ref: "a_skill", slug: "x", title: "y" }),
    ).rejects.toMatchObject({ status: 400 });
    const same = await rename("a_skill", "a_skill");
    expect(same.warnings).toEqual([
      "Nothing to change: it already has that name.",
    ]);
    expect(await commits()).toBe(n + 1);
  });

  it("names follow the skill-name rule: a dash is allowed, what a folder cannot safely be is a 400", async () => {
    await seed("report");
    const n = await commits();
    const shape =
      "A skill name is lowercase a-z, 0-9, '-' and '_', starting with a letter or digit (it is the skill's folder name).";
    for (const [bad, said] of [
      ["Report", shape],
      ["my report", shape],
      ["../up", shape],
      ["a/b", shape],
      ["-flag", shape],
      ["_private", shape],
      ["a.b", shape],
      ["é", shape],
      ["x".repeat(81), "The name is longer than 80 characters."],
      ["con", "a device name Windows reserves"],
      ["507f1f77bcf86cd799439011", "looks like an object id"],
    ]) {
      const outcome = await rename("report", bad).then(
        () => "renamed",
        (e: { status?: number; message: string }) => [e.status, e.message],
      );
      // The sentence is the shared rule's, the one the Rename dialog shows.
      expect([bad, outcome]).toEqual([bad, [400, skillNameError(bad)]]);
      expect(skillNameError(bad)).toContain(said);
    }
    expect(await commits()).toBe(n);
    await rename("report", "weekly-report_v2");
    // Its other spelling of `-` and `_` is the same name: no alias needed,
    // and both spellings open it, before and after.
    await rename("weekly-report_v2", "weekly_report-v2");
    expect(await aliasesOf("weekly_report-v2")).toEqual(["report"]);
    for (const name of ["weekly-report_v2", "weekly_report_v2", "report"]) {
      expect([name, await loads(name)]).toEqual([name, "weekly_report-v2"]);
    }
  });

  it("names YAML would read as a number, a date, a boolean or null stay strings in the file", async () => {
    await seed("first");
    const chain = ["2026", "2026-10-06", "true", "no", "null", "1e3", "012"];
    let from = "first";
    for (const name of chain) {
      await rename(from, name);
      from = name;
    }
    const md = await skillMd("012");
    expect(parseSkillFile("012", md)?.aliases).toEqual([
      "first",
      ...chain.slice(0, -1),
    ]);
    expect(md).toContain("name: '012'\n");
    expect(md).toContain(
      "aliases: [first, '2026', '2026-10-06', 'true', 'no', 'null', '1e3']\n",
    );
    for (const old of ["first", ...chain]) {
      expect([old, await loads(old)]).toEqual([old, "012"]);
    }
  });

  it(`keeps the newest ${MAX_ALIASES} old names`, async () => {
    await seed("n0");
    for (let i = 1; i <= MAX_ALIASES + 2; i++) {
      await rename(`n${i - 1}`, `n${i}`);
    }
    const kept = await aliasesOf(`n${MAX_ALIASES + 2}`);
    expect(kept).toHaveLength(MAX_ALIASES);
    expect([kept[0], kept[kept.length - 1]]).toEqual([
      "n2",
      `n${MAX_ALIASES + 1}`,
    ]);
    // A name older than that is one git history still answers for.
    expect(await loads("n0")).toBe(`n${MAX_ALIASES + 2}`);
  });
});

// ── Whose name is it ────────────────────────────────────────────────

describe("a live name beats an old one, and only live skills compete", () => {
  it("an old name two skills claim opens neither; a new skill saved under an old name takes it", async () => {
    await seed("pricing");
    await rename("pricing", "pricing_eu");
    // A copy of the folder keeps the front matter, old names included.
    const md = await skillMd("pricing_eu");
    await push({
      writes: {
        "skills/pricing_us/SKILL.md": md.replace("pricing_eu", "pricing_us"),
      },
    });
    expect(await resolves("pricing")).toBeNull();
    expect(await loads("pricing")).toBeNull();

    // A new skill saved as `pricing` is live under that name, and both
    // others drop it from their old names in the same commit.
    const euBefore = await skillMd("pricing_eu");
    const n = await commits();
    await seed("pricing");
    expect(await commits()).toBe(n + 1);
    expect(await resolves("pricing")).toBe("pricing (current)");
    expect(await aliasesOf("pricing_eu")).toEqual([]);
    expect(await aliasesOf("pricing_us")).toEqual([]);
    expect(await skillMd("pricing_eu")).toBe(
      euBefore.replace("aliases: [pricing]\n", ""),
    );
    // The name stays given up after the newcomer is deleted.
    await deleteSkill(WS, "pricing", "u1");
    expect(await resolves("pricing")).toBeNull();
  });

  it("an agent's proposal under an old name takes nothing until it is approved", async () => {
    await seed("churn");
    await rename("churn", "churn_v2");
    const n = await commits();
    await seed("churn", "agent"); // a proposal: saved suppressed
    expect(await commits()).toBe(n + 1);
    // The approved playbook still answers to its old name…
    expect(await loads("churn")).toBe("churn_v2");
    expect(await resolves("churn")).toBe("churn_v2 (alias)");
    expect(await aliasesOf("churn_v2")).toEqual(["churn"]);
    // …the proposal is listed, pending, and its id is its own.
    const proposal = (await listSkillsForAdmin(WS)).find(
      s => s.name === "churn",
    ) ?? { id: "", suppressed: false };
    expect(proposal.suppressed).toBe(true);
    expect(await resolves(proposal.id)).toBe("churn (current)");
    // Editing it by name keeps it pending and retires nothing.
    await saveSkill(
      WS,
      { name: "churn", loadWhen: "when asked", body: "A better body." },
      "u1",
    );
    expect(await loads("churn")).toBe("churn_v2");
    // A second proposal that also lists the old name does not make the
    // live skill's claim ambiguous.
    await push({
      writes: {
        "skills/churn_draft/SKILL.md": serializeSkillFile({
          name: "churn_draft",
          loadWhen: "when asked",
          entities: [],
          suppressed: true,
          pinned: false,
          aliases: ["churn"],
          body: "Draft.",
        }),
      },
    });
    expect(await loads("churn")).toBe("churn_v2");

    // Approving the proposal gives it the name: every other skill drops it.
    expect(await toggleSkillSuppressed(WS, proposal.id, false, "u1")).toBe(
      true,
    );
    expect(await loads("churn")).toBe("churn");
    expect(await resolves("churn")).toBe("churn (current)");
    expect(await aliasesOf("churn_v2")).toEqual([]);
    expect(await aliasesOf("churn_draft")).toEqual([]);
  });

  it("a workspace skill renamed away from a system skill's name stops shadowing it", async () => {
    const system = getSystemSkillIndex()[0].name;
    const idOf = async (name: string) => {
      const r = await loadSkill(WS, name);
      return r.success ? r.skill.id : null;
    };
    const systemId = await idOf(system);
    await seed(system);
    expect(await idOf(system)).toBe(skillId(WS, system));
    await rename(system, "our_take");
    // An old name is a courtesy, never a claim on a live name.
    expect(await idOf(system)).toBe(systemId);
    expect(await resolves(system)).toBe("our_take (alias)");
  });

  it("the same names in two workspaces never meet", async () => {
    await seed("shared");
    await rename("shared", "renamed");
    const [first, firstId] = [WS, skillId(WS, "shared")];
    WS = new Types.ObjectId().toString();
    await initRepo(repoDirFor(WS), { "README.md": "# other\n" });
    await bindTestWorkspaceRepo(WS);
    await seed("shared");
    expect(await resolves("shared")).toBe("shared (current)");
    expect(await resolves("renamed")).toBeNull();
    expect(await resolves(firstId)).toBeNull();
    WS = first;
    expect(await resolves("shared")).toBe("renamed (alias)");
  });
});

// ── Races and files the editor must not break ───────────────────────

describe("nothing is lost: races, hand-written front matter, odd bytes", () => {
  it.each<[string, () => Promise<unknown>]>([
    [
      "a save to the skill",
      () =>
        saveSkill(
          WS,
          { name: "live", loadWhen: "when asked", body: "Edited meanwhile." },
          "u2",
        ),
    ],
    [
      "a helper added to its folder",
      () => push({ writes: { "skills/live/helper.py": "print(1)\n" } }),
    ],
    [
      "a file appearing in the new folder",
      () => push({ writes: { "skills/moved/notes.md": "x\n" } }),
    ],
  ])("%s landing mid-rename: 409, what landed is kept", async (_l, land) => {
    await seed("live");
    race.beforeRename = land;
    const n = await commits();
    await expect(rename("live", "moved")).rejects.toMatchObject({
      status: 409,
    });
    expect(race.beforeRename).toBeNull(); // the race really ran
    expect(await commits()).toBe(n + 1);
    expect(await loads("live")).toBe("live");
    expect(await paths()).not.toContain("skills/moved/SKILL.md");
  });

  it("of two renames at once exactly one lands", async () => {
    await seed("twice");
    const outcomes = await Promise.allSettled([
      rename("twice", "one"),
      rename("twice", "two"),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const names = (await loadSkillCatalog(WS)).skills.map(s => s.name);
    expect(names).toHaveLength(1);
    expect(await loads("twice")).toBe(names[0]);
  });

  it("the front matter editor keeps every other line, and refuses what it cannot keep", () => {
    const md = (head: string) => `---\n${head}\n---\n\nA body.\n`;
    const edit = (head: string, e: { name?: string; aliases?: string[] }) => {
      const out = editSkillFrontMatter("s", md(head), e);
      return out.ok ? out.contents : "refused";
    };
    const base = "name: old # the name\ndescription: when asked\nlicense: MIT";
    expect(edit(base, { name: "s", aliases: ["old"] })).toBe(
      md(`${base.replace("old", "s")}\naliases: [old]`),
    );
    // No `name:` line at all (the folder is the name): one is added.
    expect(edit("description: when asked", { name: "s" })).toBe(
      md("name: s\ndescription: when asked"),
    );
    // A flow list and a block list (indented or not) are replaced whole.
    for (const list of [
      "aliases: [a, b]",
      "aliases:\n  - a\n  - b",
      "aliases:\n- a\n- b",
    ]) {
      expect(edit(`${base}\n${list}`, { aliases: ["b", "c"] })).toBe(
        md(`${base}\naliases: [b, c]`),
      );
      expect(edit(`${list}\n${base}`, { aliases: [] })).toBe(md(base));
    }
    // CRLF files keep their line endings.
    const crlf = md(base).replace(/\n/g, "\r\n");
    const out = editSkillFrontMatter("s", crlf, { aliases: ["x"] });
    expect(out.ok && out.contents).toBe(
      md(`${base}\naliases: [x]`).replace(/\n/g, "\r\n"),
    );
    // Shapes a line edit would break are refused, with the fix spelled out.
    for (const head of [
      `${base}\naliases: [a,\n  b]`,
      `${base}\naliases: &old [a]\nother: *old`,
    ]) {
      expect(edit(head, { aliases: ["c"] })).toBe("refused");
    }
    const none = editSkillFrontMatter("s", "No front matter.\n", {
      aliases: ["c"],
    });
    expect(none).toEqual({
      ok: false,
      reason: expect.stringContaining("set `aliases: [c]`"),
    });
  });

  it("a SKILL.md that is not UTF-8, or does not parse, is refused and left byte for byte", async () => {
    await seed("legacy");
    const latin1 = Buffer.from(
      "---\nname: legacy\ndescription: caf\xe9\n---\n\nBody.\n",
      "latin1",
    );
    const [oid] = await writeBlobs(repoDirFor(WS), [latin1]);
    await push({
      entries: [{ path: "skills/legacy/SKILL.md", oid, mode: "100644" }],
      writes: { "skills/broken/SKILL.md": "---\nname: broken\n---\n\nBody.\n" },
    });
    const n = await commits();
    await expect(rename("legacy", "renamed")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("is not UTF-8 text"),
    });
    // A file with no description is not a skill: there is nothing to rename.
    for (const ref of ["broken", skillId(WS, "broken")]) {
      await expect(rename(ref, "renamed")).rejects.toMatchObject({
        status: 404,
      });
    }
    expect(await commits()).toBe(n);
    expect((await rawAt("skills/legacy/SKILL.md"))?.equals(latin1)).toBe(true);
  });
});
