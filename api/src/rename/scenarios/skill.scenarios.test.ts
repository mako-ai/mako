/**
 * SCENARIOS — renaming workspace skills (kind `skill`).
 *
 * A skill IS `skills/<name>/SKILL.md` at main; the folder name is its
 * identity and its id is derived from it. After every scenario, whatever
 * the entry point (POST /objects — the Skills panel —, the MCP
 * `rename_object` tool, a laptop `git mv` pushed through the git endpoint):
 *
 *   - one commit on main moves the whole folder (helpers by oid, modes
 *     kept) and records the old name in the front matter `aliases`;
 *   - every old name, and an id minted from one, still opens the skill —
 *     unless the name was taken by a live skill (the live name wins) or two
 *     skills claim it (it opens nothing rather than the wrong playbook);
 *   - nothing else in the repo changes, and nothing of another workspace.
 *
 * Real bare repos + mongodb-memory-server (only for the repo binding).
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
import yaml from "js-yaml";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// A commit landing on main inside a rename's read→commit window.
const race = vi.hoisted(() => ({
  beforeRename: undefined as undefined | (() => Promise<void>),
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
      if (hook && /^Rename skill/.test(args[3]?.message ?? "")) {
        race.beforeRename = undefined;
        await hook();
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});

const auth = vi.hoisted(() => ({
  authType: "session" as string,
  role: "member" as string,
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    c.set("user", { id: "u1" });
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: auth.role })),
  },
}));

import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log as repoLog,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  invalidateSkillCatalog,
  skillId,
} from "../../apps/workspace-skills.service";
import { serializeSkillFile, skillFilePath } from "../../apps/skill-files";
import {
  deleteSkill,
  loadSkill,
  saveSkill,
} from "../../services/skills.service";
import { objectRoutes } from "../../routes/objects";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { missingInputConditionalGrant } from "../../agent-lib/capabilities/runtime";
import { capabilityGrantsFromScopes } from "../../auth/api-key-scopes";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = () => ({ workspaceId: WS, userId: "u1", role: "member" });

const app = new Hono();
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-scenarios-"));
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

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  race.beforeRename = undefined;
  auth.authType = "session";
  auth.role = "member";
  await initRepo(repoDirFor(WS), { "README.md": "# workspace\n" });
  await bindTestWorkspaceRepo(WS);
});

// ── Fixtures ────────────────────────────────────────────────────────

const body = (name: string) =>
  [
    `How we do ${name}: a playbook long enough that git can tell a moved`,
    "and lightly edited copy from a new file.",
    "",
    "1. Read the brief.",
    "2. Check the numbers against the warehouse.",
    "3. Write it up, cite the consoles you used.",
    "",
  ].join("\n");

async function seedSkill(name: string, extra: Record<string, string> = {}) {
  const r = await saveSkill(
    WS,
    { name, loadWhen: `when asked about ${name}`, body: body(name) },
    "u1",
  );
  expect(r.success).toBe(true);
  if (Object.keys(extra).length > 0) {
    await laptop({
      writes: Object.fromEntries(
        Object.entries(extra).map(([p, c]) => [`skills/${name}/${p}`, c]),
      ),
    });
  }
}

async function laptop(
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
  message = "laptop push",
) {
  await commitBlobsOnBranch(repoDirFor(WS), DEFAULT_BRANCH, mutation, {
    message,
    author: { name: "Laptop", email: "laptop@example.com" },
  });
  invalidateSkillCatalog(WS);
}

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

const commits = async () => (await repoLog(repoDirFor(WS), MAIN, 5000)).length;
const resolveName = async (ref: string) =>
  (await resolveObjectRef(ctx(), "skill", ref))?.current.slug ?? null;
const rename = (ref: string, to: string) =>
  renameObject(ctx(), "skill", { ref, slug: to });

function objects(method: "GET" | "POST", url: string, b?: unknown) {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/objects${url}`, {
      method,
      ...(b === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(b),
          }),
    }),
  );
}

// ── Entry points ────────────────────────────────────────────────────

describe("entry points", () => {
  it("Skills panel (POST /objects), rename_object, laptop git mv with and without aliases — one commit each, every old name resolves", async () => {
    await seedSkill("kpi_defs", { "helpers/query.sql": "select 1\n" });
    const before = await pathsAtMain();
    let n = await commits();

    const ui = await objects("POST", "/skill/rename", {
      ref: "kpi_defs",
      slug: "kpi_definitions",
    });
    expect(ui.status, await ui.clone().text()).toBe(200);
    expect(await commits()).toBe(n + 1);
    expect(await pathsAtMain()).toEqual(
      before.map(p => p.replace("skills/kpi_defs/", "skills/kpi_definitions/")),
    );
    expect(await fileAt("skills/kpi_definitions/helpers/query.sql")).toBe(
      "select 1\n",
    );

    const exec = createRenameTools(WS, "u1").rename_object.execute as (
      i: Record<string, unknown>,
      o: unknown,
    ) => Promise<{ success: boolean; error?: string }>;
    n = await commits();
    const tool = await exec(
      { kind: "skill", ref: "kpi_defs", slug: "metrics" },
      { toolCallId: "t", messages: [] },
    );
    expect(tool.success, tool.error).toBe(true);
    expect(await commits()).toBe(n + 1);

    // Laptop: git mv WITH the alias written by hand.
    const text = (await fileAt(skillFilePath("metrics")))!;
    await laptop({
      writes: {
        "skills/metrics_v2/SKILL.md": text
          .replace("name: metrics", "name: metrics_v2")
          .replace(
            "aliases: [kpi_defs, kpi_definitions]",
            "aliases: [kpi_defs, kpi_definitions, metrics]",
          ),
        "skills/metrics_v2/helpers/query.sql": "select 1\n",
      },
      deletes: [skillFilePath("metrics"), "skills/metrics/helpers/query.sql"],
    });
    // Laptop: a bare git mv + a small edit (no alias): git history.
    const v2 = (await fileAt(skillFilePath("metrics_v2")))!;
    await laptop({
      writes: {
        "skills/metrics_v3/SKILL.md": `${v2}\n4. (edited on a laptop)\n`,
        "skills/metrics_v3/helpers/query.sql": "select 1\n",
      },
      deletes: [
        skillFilePath("metrics_v2"),
        "skills/metrics_v2/helpers/query.sql",
      ],
    });
    for (const old of [
      "kpi_defs",
      "kpi_definitions",
      "metrics",
      "metrics_v2",
      skillId(WS, "kpi_defs"),
    ]) {
      expect([old, await resolveName(old)]).toEqual([old, "metrics_v3"]);
    }
    expect(await loadSkill(WS, "kpi_defs")).toMatchObject({
      success: true,
      skill: { name: "metrics_v3" },
    });
    // A rename through a name only git history knows still renames it.
    const viaHistory = await rename("metrics_v2", "metrics_final");
    expect(viaHistory.after.slug).toBe("metrics_final");
  });

  it("over MCP: query:read alone cannot rename a skill (git-write can); POST /objects refuses API keys", async () => {
    const readOnly = new Set([
      "artifact-write",
      "schedule-write",
      ...capabilityGrantsFromScopes(["query:read"]),
    ]);
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "skill" },
        readOnly as never,
      ),
    ).toMatchObject({ grant: "git-write" });
    expect(
      missingInputConditionalGrant(
        "rename_object",
        { kind: "skill" },
        new Set([
          ...readOnly,
          ...capabilityGrantsFromScopes(["git:write"]),
        ]) as never,
      ),
    ).toBeNull();
    await seedSkill("alpha");
    auth.authType = "apiKey";
    const res = await objects("POST", "/skill/rename", {
      ref: "alpha",
      slug: "beta",
    });
    expect(res.status).toBe(403);
    expect(await resolveName("alpha")).toBe("alpha");
  });
});

// ── Operations ──────────────────────────────────────────────────────

describe("operations", () => {
  it("slug, title, both (agreeing or refused), no-ops, back, a→b→c, onto live / old / own-old names", async () => {
    await seedSkill("a_skill");
    await seedSkill("other");
    const n = await commits();
    // no-ops
    for (const same of [
      { slug: "a_skill" },
      { title: "a_skill" },
      { slug: " a_skill " },
    ]) {
      const r = await renameObject(ctx(), "skill", { ref: "a_skill", ...same });
      expect(r.warnings.join(" ")).toMatch(/Nothing to change/);
    }
    expect(await commits()).toBe(n);
    await expect(
      renameObject(ctx(), "skill", { ref: "a_skill", slug: "x", title: "y" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await renameObject(ctx(), "skill", { ref: "a_skill", title: "b_skill" }))
        .after.slug,
    ).toBe("b_skill");
    expect((await rename("b_skill", "c_skill")).after.slug).toBe("c_skill");
    // onto a live name, onto another skill's old name: refused
    await expect(rename("c_skill", "other")).rejects.toMatchObject({
      status: 409,
    });
    await rename("other", "other_v2");
    await expect(rename("c_skill", "other")).rejects.toMatchObject({
      status: 409,
    });
    // onto its own old name: the alias list swaps
    await rename("c_skill", "a_skill");
    const text = (await fileAt(skillFilePath("a_skill")))!;
    expect(text).toMatch(/aliases: \[b_skill, c_skill\]/);
    for (const old of ["b_skill", "c_skill"]) {
      expect(await resolveName(old)).toBe("a_skill");
    }
    expect(await resolveName("other")).toBe("other_v2");
  });

  it("delete then recreate at the old name: the newcomer owns it; deleting the newcomer leaves a dead link", async () => {
    await seedSkill("report");
    await rename("report", "report_v2");
    // A new skill saved under the old name takes it (the alias is retired
    // from report_v2 in the same commit).
    await seedSkill("report");
    expect(await resolveName("report")).toBe("report");
    expect(await fileAt(skillFilePath("report_v2"))).not.toMatch(/aliases:/);
    const del = await deleteSkill(WS, "report", "u1");
    expect(del).toMatchObject({ success: true, deleted: true });
    invalidateSkillCatalog(WS);
    expect(await resolveName("report")).toBeNull();
    expect(await resolveName("report_v2")).toBe("report_v2");
  });

  it("a copied folder does not inherit the original's old names", async () => {
    await seedSkill("onboarding");
    await rename("onboarding", "onboarding_v2");
    // cp -r skills/onboarding_v2 skills/onboarding_copy (aliases copied).
    const text = (await fileAt(skillFilePath("onboarding_v2")))!;
    await laptop({
      writes: {
        "skills/onboarding_copy/SKILL.md": text.replace(
          "name: onboarding_v2",
          "name: onboarding_copy",
        ),
      },
    });
    expect(await resolveName("onboarding")).toBe("onboarding_v2");
    expect(await loadSkill(WS, "onboarding")).toMatchObject({
      success: true,
      skill: { name: "onboarding_v2" },
    });
  });

  it("two skills that BOTH were renamed from one name: it opens neither", async () => {
    await seedSkill("shared");
    await rename("shared", "first");
    // A second skill claims `shared` by hand (no history behind it).
    await seedSkill("second");
    const t = (await fileAt(skillFilePath("second")))!;
    await laptop({
      writes: {
        [skillFilePath("second")]: t.replace(
          "\n---",
          "\naliases: [shared]\n---",
        ),
      },
    });
    // Git history says `shared` became `first` — that is not a guess, so
    // the hand-written claim does not make the link ambiguous…
    expect(await resolveName("shared")).toBe("first");
    // …but with no history (a claim on both sides by hand), nobody wins.
    await seedSkill("third");
    const t3 = (await fileAt(skillFilePath("third")))!;
    await laptop({
      writes: {
        [skillFilePath("third")]: t3.replace(
          "\n---",
          "\naliases: [ghost]\n---",
        ),
        [skillFilePath("second")]: (await fileAt(
          skillFilePath("second"),
        ))!.replace("aliases: [shared]", "aliases: [shared, ghost]"),
      },
    });
    expect(await resolveName("ghost")).toBeNull();
  });
});

// ── Hostile names, other workspaces ─────────────────────────────────

describe("hostile names and other workspaces", () => {
  it("every name a folder cannot safely be is a 400; nothing is committed", async () => {
    await seedSkill("safe");
    const n = await commits();
    for (const to of [
      "",
      " ",
      "Safe",
      "SAFE",
      "../x",
      "a/b",
      "a\\b",
      ".",
      "..",
      "~x",
      "%2e%2e",
      "a.b",
      "a-b",
      "a b",
      "é",
      "é",
      "x​",
      "x\u0000",
      "‮x",
      "😀",
      "con:",
      "a".repeat(81),
      "a".repeat(10_000),
    ]) {
      const outcome = await rename("safe", to).then(
        r => `accepted ${r.after.slug}`,
        (e: { status?: number }) => e.status,
      );
      expect([JSON.stringify(to).slice(0, 30), outcome]).toEqual([
        JSON.stringify(to).slice(0, 30),
        to.trim() === "safe" ? expect.anything() : 400,
      ]);
    }
    expect(await commits()).toBe(n);
    // Surrounding whitespace is trimmed (a safe normalization).
    expect((await rename("safe", "safe_v2\n")).after.slug).toBe("safe_v2");
    await rename("safe_v2", "safe");
    // Folder-root and id-looking names are just names, inside skills/.
    expect((await rename("safe", "skills")).after.slug).toBe("skills");
    expect(
      (await rename("skills", "0123456789abcdef01234567")).after.slug,
    ).toBe("0123456789abcdef01234567");
    expect(
      (await pathsAtMain()).filter(
        p => !p.startsWith("skills/") && p !== "README.md",
      ),
    ).toEqual([]);
  });

  it("the same names in two workspaces never interfere; another workspace's id never resolves", async () => {
    await seedSkill("weekly");
    const ws1 = WS;
    const ws1Id = skillId(ws1, "weekly");
    WS = new Types.ObjectId().toString();
    await initRepo(repoDirFor(WS), { "README.md": "# ws2\n" });
    await bindTestWorkspaceRepo(WS);
    await seedSkill("weekly");
    await rename("weekly", "weekly_v2");
    expect(await resolveObjectRef(ctx(), "skill", ws1Id)).toBeNull();
    WS = ws1;
    expect(await resolveName("weekly")).toBe("weekly");
    expect(await resolveName("weekly_v2")).toBeNull();
  });
});

// ── Concurrency and partial failure ─────────────────────────────────

describe("concurrency and partial failure", () => {
  it("two renames at once: one lands, the other is refused, nothing half-moved", async () => {
    await seedSkill("race_me");
    const outcomes = await Promise.allSettled([
      rename("race_me", "left"),
      rename("race_me", "right"),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const paths = await pathsAtMain();
    expect(
      ["skills/left/SKILL.md", "skills/right/SKILL.md"].filter(p =>
        paths.includes(p),
      ),
    ).toHaveLength(1);
    expect(paths).not.toContain("skills/race_me/SKILL.md");
  });

  it("a save, a delete or an added helper landing mid-rename: refused (409), the landed change kept", async () => {
    for (const land of [
      async () =>
        laptop({
          writes: {
            [skillFilePath("busy")]: serializeSkillFile({
              name: "busy",
              loadWhen: "edited",
              entities: [],
              suppressed: false,
              pinned: false,
              body: "edited body",
            }),
          },
        }),
      async () => laptop({ deletes: [skillFilePath("busy")] }),
      async () => laptop({ writes: { "skills/busy/new.md": "added\n" } }),
    ]) {
      WS = new Types.ObjectId().toString();
      await initRepo(repoDirFor(WS), { "README.md": "# w\n" });
      await bindTestWorkspaceRepo(WS);
      await seedSkill("busy");
      race.beforeRename = land;
      await expect(rename("busy", "calm")).rejects.toMatchObject({
        status: 409,
      });
      expect(race.beforeRename).toBeUndefined();
      expect(
        (await pathsAtMain()).some(p => p.startsWith("skills/calm/")),
      ).toBe(false);
    }
  });

  it("the git commit fails: nothing moves, the old name still loads", async () => {
    await seedSkill("fragile");
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    race.beforeRename = async () => {
      throw new Error("disk full");
    };
    await expect(rename("fragile", "sturdy")).rejects.toMatchObject({
      status: 400,
    });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    expect(await resolveName("fragile")).toBe("fragile");
  });
});

// ── Names YAML would read as something else ─────────────────────────

describe("names YAML would read as a number, a date, a boolean or null", () => {
  it("2026 → (2026-10-06 refused) → true → no → null → 1e3 → 0x1f → 012: the file parses, aliases are exact strings, every old name opens it", async () => {
    await seedSkill("base");
    const chain = ["2026", "true", "no", "null", "1e3", "0x1f", "012"];
    let current = "base";
    const old: string[] = [];
    for (const to of chain) {
      if (to === "true") {
        // Not a skill name at all (a dash): refused, nothing moves.
        await expect(rename(current, "2026-10-06")).rejects.toMatchObject({
          status: 400,
        });
      }
      const r = await rename(current, to);
      expect(r.after.slug).toBe(to);
      old.push(current);
      current = to;
      const text = (await fileAt(skillFilePath(current)))!;
      const fm = yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)![1]) as {
        name: unknown;
        aliases: unknown[];
      };
      expect([to, fm.name]).toEqual([to, to]);
      expect(fm.aliases.every(a => typeof a === "string")).toBe(true);
      expect([...fm.aliases].sort()).toEqual([...old].sort());
      invalidateSkillCatalog(WS);
      for (const name of old) {
        expect([name, await resolveName(name)]).toEqual([name, current]);
      }
    }
    expect(await loadSkill(WS, "2026")).toMatchObject({
      success: true,
      skill: { name: "012" },
    });
  });
});

// ── Chains and scale ────────────────────────────────────────────────

describe("chains and scale", () => {
  it("a 25-step chain keeps every old name; 150 skills × 10 aliases resolve fast", async () => {
    await seedSkill("chain");
    let current = "chain";
    for (let i = 1; i <= 25; i++) {
      await rename(current, `chain_${i}`);
      current = `chain_${i}`;
    }
    for (const old of ["chain", "chain_1", "chain_12", "chain_24"]) {
      expect(await resolveName(old)).toBe("chain_25");
    }
    const writes: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      writes[skillFilePath(`s${i}`)] = serializeSkillFile({
        name: `s${i}`,
        loadWhen: `when ${i}`,
        entities: [],
        suppressed: false,
        pinned: false,
        aliases: Array.from({ length: 10 }, (_, j) => `s${i}_old${j}`),
        body: body(`s${i}`),
      });
    }
    await laptop({ writes });
    let t = Date.now();
    expect(await resolveName("s77_old5")).toBe("s77");
    const coldMs = Date.now() - t;
    t = Date.now();
    for (let i = 0; i < 150; i++) {
      expect(await resolveName(`s${i}_old9`)).toBe(`s${i}`);
    }
    const warmMs = (Date.now() - t) / 150;
    console.info(
      `[scale] skills: 176 skills / 1525 aliases — cold catalog + resolve ${coldMs}ms, warm resolve ${warmMs.toFixed(2)}ms`,
    );
    expect(coldMs).toBeLessThan(10_000);
    expect(warmMs).toBeLessThan(50);
  }, 300_000);
});
