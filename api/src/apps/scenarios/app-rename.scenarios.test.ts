/**
 * Graceful rename of APPS, walked as a matrix against the real code: real
 * bare repos, a real `git clone`/`git mv`/`git push` for the laptop, and
 * mongodb-memory-server (./app-scenario-harness.ts).
 *
 *  - the real-world anchor: RealAdvisor's apps/traffic-performance
 *    (id 6aa30149273767efe9ee382a), renamed from apps/seller-media-buying-3
 *    by the exact history shape its repo has;
 *  - every entry point (rename_object through the registry and through
 *    the agent tool, app_move_app, a laptop push) gives one and the same
 *    result for the same operation;
 *  - every operation (title, slug, both, another folder or tree, back to
 *    a previous name, onto a live / old / case-twin name, its own name in
 *    another case, twice, delete + recreate, copy, never indexed, no-op)
 *    keeps the id and everything attached, records the old name, and
 *    touches nothing else.
 *
 * Roles, links and workspaces: app-rename-access.scenarios.test.ts.
 * Hostile names, chains and scale: app-rename-hostile.scenarios.test.ts.
 * Failures between steps and races: app-rename-races.scenarios.test.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  Favourite,
} from "../../database/workspace-schema";
import {
  invalidateAppsIndexCache,
  loadAppsIndex,
  syncAppsIndexFromRepo,
} from "../app-index.service";
import { parseAppManifest } from "../app-paths";
import {
  commitChanges,
  commitFileVersions,
  createProjectWith,
  deleteProject,
  ensureProjectRow,
  ensureWorktree,
  execInWorktree,
  moveProject,
  readSessionFile,
  projectHistory,
  resolveProjectRef,
  scopeOf,
  writeFile,
} from "../worktree.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { startTestGitServer, type TestGitServer } from "../test-git-server";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { createAppsTools } from "../../agent-lib/tools/apps-tools";
import {
  addMember,
  changedPaths,
  commitsSince,
  externalCommit,
  fileAt,
  headOf,
  indexed,
  laptopPush,
  manifest,
  newId,
  resetWorkspace,
  startScenarioEnv,
  type ScenarioEnv,
} from "./app-scenario-harness";

let env: ScenarioEnv;
// Mako's own git endpoint on a real port: the sandbox clones from it and
// pushes to it, so a `git mv` made there arrives the way a terminal's does
// — receive-pack, then the push hook (notifyRepoPushed).
let gitServer: TestGitServer;
beforeAll(async () => {
  env = await startScenarioEnv("app-rename-scenarios");
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
});
afterAll(async () => {
  await gitServer?.close();
  await env.stop();
});

const WS = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const B_ID = newId();
const D_ID = newId();
const admin = { workspaceId: WS, userId: ADMIN, role: "admin" };

beforeEach(async () => {
  await resetWorkspace(env, WS, {
    "README.md": "workspace\n",
    // A: an app from before ids (78 of RealAdvisor's 90 apps are like it).
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export const a = 1;\n",
    "apps/a/package.json": '{ "name": "a" }\n',
    // B: stamped, nested.
    "apps/Sales/CH/b/mako.json": manifest("B", B_ID),
    "apps/Sales/CH/b/src/main.tsx": "export const b = 1;\n",
    // D: stamped, top level — the "other app" of every collision.
    "apps/d/mako.json": manifest("D", D_ID),
    "apps/d/src/main.tsx": "export const d = 1;\n",
    [`users/${ADMIN}/apps/mine/mako.json`]: manifest("Mine"),
    "consoles/x.sql": "select 1\n",
  });
  await addMember(WS, ADMIN, "admin");
  await Favourite.deleteMany({});
});

/** What an app carries besides its files: sharing, deploys, env, stars. */
async function attachState(appId: string) {
  const ref = (await resolveProjectRef(WS, appId))!;
  await ensureProjectRow(ref, ADMIN);
  const OTHER = new Types.ObjectId().toString();
  await AppProject.updateOne(
    { _id: new Types.ObjectId(appId) },
    {
      $set: {
        access: "workspace",
        workspaceRole: "editor",
        sharedWith: [{ userId: OTHER, role: "editor" }],
        publicShare: { enabled: true, token: `tok-${appId}` },
        env: [{ key: "API", valueEncrypted: "enc", secret: true }],
        publishedSha: "f".repeat(40),
        publishedAt: new Date("2026-01-01T00:00:00Z"),
      },
    },
  );
  await Favourite.create({
    workspaceId: new Types.ObjectId(WS),
    userId: ADMIN,
    type: "item",
    kind: "app",
    refId: appId,
    title: "starred",
    position: 0,
  });
}

/** The attached state, minus where the app is (which a rename changes). */
async function stateOf(appId: string) {
  const row = await AppProject.findById(appId).lean();
  const star = await Favourite.findOne({ refId: appId }).lean();
  return {
    access: row?.access,
    workspaceRole: row?.workspaceRole,
    sharedWith: row?.sharedWith?.map(s => [s.userId, s.role]),
    publicShare: row?.publicShare?.token,
    env: row?.env?.map(e => e.key),
    publishedSha: row?.publishedSha,
    owner: row?.owner_id,
    star: star?.refId,
  };
}

/** Every OTHER app's index row, as a comparable value. */
async function othersOf(appId: string) {
  return (await loadAppsIndex(WS)).apps
    .filter(a => a.appId !== appId)
    .map(a => ({
      appId: a.appId,
      path: a.path,
      treeOid: a.treeOid,
      title: a.title,
      aliases: a.aliases,
    }));
}

async function idOf(ref: string): Promise<string> {
  const found = await resolveObjectRef(admin, "app", ref);
  if (!found) throw new Error(`no app answers ${ref}`);
  return found.id;
}

/**
 * The identity contract after a rename: same id, the new name current,
 * every old name an alias pointing at the new address, the attached state
 * as it was, and the row (when there is one) at the new path.
 */
async function expectIdentity(
  appId: string,
  expected: {
    path: string;
    title?: string;
    url: string;
    oldNames: string[];
    state?: Awaited<ReturnType<typeof stateOf>>;
  },
) {
  const now = await resolveObjectRef(admin, "app", appId);
  expect(now).toMatchObject({
    id: appId,
    via: "current",
    current: {
      path: expected.path,
      url: expected.url,
      ...(expected.title ? { title: expected.title } : {}),
    },
  });
  for (const old of expected.oldNames) {
    expect(await resolveObjectRef(admin, "app", old), old).toMatchObject({
      id: appId,
      via: "alias",
      current: { path: expected.path, url: expected.url },
    });
  }
  if (expected.state) {
    expect(await stateOf(appId)).toEqual(expected.state);
    const row = await AppProject.findById(appId).lean();
    expect(row?.path).toBe(expected.path);
    expect(row?.slug).toBe(expected.path.split("/").pop());
    if (expected.title) expect(row?.title).toBe(expected.title);
  }
  // The project resolver (every route and tool) agrees.
  expect((await resolveProjectRef(WS, appId))?.path).toBe(expected.path);
}

// ---------------------------------------------------------------------------
// The real-world anchor
// ---------------------------------------------------------------------------

describe("the real-world anchor: apps/traffic-performance, once apps/seller-media-buying-3", () => {
  // RealAdvisor's mako-workspace, commits fbc562dd … acd0c0a2: three
  // creates of "Seller Media Buying" (two deleted), the third — this app —
  // created UNSTAMPED with a random row id, `git mv`'d away from its name
  // and back from a laptop, moved by Mako's UI to traffic-performance
  // before aliases existed (the move stamped the id, wrote no alias), and
  // its title edited from a laptop afterwards.
  const ANCHOR = "6aa30149273767efe9ee382a";
  const smb = (n = "") => `apps/seller-media-buying${n}`;
  const desc = {
    description:
      "Acquisition dashboard for the non-pro funnels: every channel paid and unpaid, campaign drill-down with lead quality, and a trust tab that explains every number.",
  };
  const unstamped = (title = "Seller Media Buying") =>
    manifest(title, undefined, desc);
  const files = (root: string, mako: string) => ({
    [`${root}/mako.json`]: mako,
    [`${root}/package.json`]: '{ "name": "seller-media-buying" }\n',
    [`${root}/src/main.tsx`]: "export const app = 'smb';\n",
    [`${root}/README.md`]: "# Seller Media Buying\n",
  });
  const gone = (root: string) => Object.keys(files(root, ""));

  /** Replays the anchor's history; `sync` runs after every push when set. */
  async function replay(sync: boolean) {
    const step = async (
      writes: Record<string, string>,
      deletes: string[],
      message: string,
    ) => {
      await externalCommit(WS, writes, deletes, message);
      if (sync) await syncAppsIndexFromRepo(WS);
    };
    await step(
      files(smb(), unstamped()),
      [],
      'Create app "Seller Media Buying"',
    );
    await step({}, gone(smb()), "remove half-registered scaffold");
    await step(files(smb(), unstamped()), [], "scaffold and bindings");
    await step(files(smb("-2"), unstamped()), [], "Create app (…-2)");
    await step({}, gone(smb("-2")), "drop duplicate scaffolds");
    await step({}, gone(smb()), "remove the half-registered record");
    await step(files(smb("-3"), unstamped()), [], "Create app (…-3)");
    // The row the old createProject wrote: a random id, the path, state.
    await AppProject.create({
      _id: new Types.ObjectId(ANCHOR),
      workspaceId: new Types.ObjectId(WS),
      title: "Seller Media Buying",
      slug: "seller-media-buying-3",
      path: smb("-3"),
      access: "workspace",
      owner_id: ADMIN,
      createdBy: ADMIN,
      sharedWith: [{ userId: "colleague", role: "editor" }],
      publishedSha: "a".repeat(40),
    });
    if (sync) await syncAppsIndexFromRepo(WS);
    // Laptop: git mv away (R100) and back (R100).
    await step(files(smb(), unstamped()), gone(smb("-3")), "reclaim the slug");
    await step(
      files(smb("-3"), unstamped()),
      gone(smb()),
      "Revert slug rename",
    );
    // Mako's UI move, before aliases: the id stamped, no alias written.
    await step(
      files(
        "apps/traffic-performance",
        manifest("Seller Media Buying", ANCHOR, desc),
      ),
      gone(smb("-3")),
      'Move app "Seller Media Buying" (apps/seller-media-buying-3 → apps/traffic-performance)',
    );
    // Laptop: the title.
    await step(
      {
        "apps/traffic-performance/mako.json": manifest(
          "Traffic Performance",
          ANCHOR,
          desc,
        ),
      },
      [],
      "rename: Seller Media Buying → Traffic Performance",
    );
  }

  async function expectAnchorResolves() {
    await expectIdentity(ANCHOR, {
      path: "apps/traffic-performance",
      title: "Traffic Performance",
      url: "/apps/traffic-performance",
      // Its own names, newest first; the deleted apps' "-2" is nobody's.
      oldNames: ["seller-media-buying-3", "apps/seller-media-buying-3"],
    });
    expect(await idOf("traffic-performance")).toBe(ANCHOR);
    // It held "seller-media-buying" last (the laptop's round trip), after
    // the two deleted apps that had it: the most recent holder owns it.
    expect(await idOf("seller-media-buying")).toBe(ANCHOR);
    expect(await resolveObjectRef(admin, "app", "seller-media-buying-2")).toBe(
      null,
    );
    const row = await AppProject.findById(ANCHOR).lean();
    expect(row).toMatchObject({
      path: "apps/traffic-performance",
      slug: "traffic-performance",
      title: "Traffic Performance",
      publishedSha: "a".repeat(40),
    });
    expect(row?.sharedWith?.map(s => s.userId)).toEqual(["colleague"]);
  }

  it("resolves with the index synced at every push, as production ran it", async () => {
    await replay(true);
    await expectAnchorResolves();
  });

  it("resolves when the index is built for the first time over that history", async () => {
    await replay(false);
    await expectAnchorResolves();
  });

  it("resolves after the index is dropped and rebuilt, and keeps every old name through a further rename", async () => {
    await replay(true);
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    await expectAnchorResolves();

    const result = await renameObject(admin, "app", {
      ref: "seller-media-buying-3",
      slug: "traffic",
    });
    expect(result).toMatchObject({
      id: ANCHOR,
      before: { path: "apps/traffic-performance" },
      after: { path: "apps/traffic", url: "/apps/traffic" },
      aliasesAdded: ["traffic-performance"],
    });
    await expectIdentity(ANCHOR, {
      path: "apps/traffic",
      title: "Traffic Performance",
      url: "/apps/traffic",
      oldNames: ["traffic-performance", "seller-media-buying-3"],
    });
  });
  it("keeps its whole history: its own commits under every name, none of the deleted apps' that had them first", async () => {
    await replay(true);
    const project = (await resolveProjectRef(WS, ANCHOR))!;
    const subjects = (await projectHistory(scopeOf(project), 50)).map(
      c => c.subject,
    );
    expect(subjects).toEqual([
      "rename: Seller Media Buying → Traffic Performance",
      'Move app "Seller Media Buying" (apps/seller-media-buying-3 → apps/traffic-performance)',
      "Revert slug rename",
      "reclaim the slug",
      "Create app (…-3)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Every entry point, one result
// ---------------------------------------------------------------------------

type EntryPoint = {
  name: string;
  /** Renames apps/a's folder to `slug` (and its title, when given). */
  rename(input: { ref: string; slug?: string; title?: string }): Promise<void>;
  /** Writes the old name into mako.json (a laptop's index remembers it). */
  writesAlias: boolean;
  /** Can change the title (and both at once, in one commit). */
  title: boolean;
};

const viaRegistry: EntryPoint = {
  name: "rename_object (registry)",
  writesAlias: true,
  title: true,
  async rename(input) {
    await renameObject(admin, "app", input);
  },
};

const viaRenameTool: EntryPoint = {
  name: "rename_object (agent/MCP tool)",
  writesAlias: true,
  title: true,
  async rename(input) {
    const tools = createRenameTools(WS, ADMIN);
    const out = (await tools.rename_object.execute!(
      { kind: "app", ...input },
      { toolCallId: "t1", messages: [] },
    )) as { success: boolean; error?: string };
    if (!out.success) throw new Error(out.error);
  },
};

const viaMoveTool: EntryPoint = {
  name: "app_move_app (agent/MCP tool)",
  writesAlias: true,
  title: false,
  async rename(input) {
    const tools = createAppsTools({ workspaceId: WS, userId: ADMIN });
    const out = (await tools.app_move_app.execute!(
      { appId: input.ref, folder: "apps", name: input.slug },
      { toolCallId: "t1", messages: [] },
    )) as { success: boolean; error?: string };
    if (!out.success) throw new Error(out.error);
  },
};

const viaLaptop: EntryPoint = {
  name: "laptop git mv + push",
  writesAlias: false,
  title: true,
  async rename(input) {
    const from = (await resolveProjectRef(WS, input.ref))!.path!;
    await laptopPush(env, WS, async ({ git, read, write }) => {
      const to = input.slug ? `apps/${input.slug}` : from;
      if (to !== from) await git("mv", from, to);
      if (input.title) {
        const raw = JSON.parse(await read(`${to}/mako.json`)) as Record<
          string,
          unknown
        >;
        await write(
          `${to}/mako.json`,
          `${JSON.stringify({ ...raw, title: input.title }, null, 2)}\n`,
        );
      }
    });
  },
};

describe.each([viaRegistry, viaRenameTool, viaMoveTool, viaLaptop])(
  "entry point: $name",
  entry => {
    it("a slug rename keeps the id and everything attached, records the old name, and touches only the app", async () => {
      const A_ID = await idOf("a");
      await attachState(A_ID);
      const state = await stateOf(A_ID);
      const others = await othersOf(A_ID);
      const before = await headOf(WS);
      await entry.rename({ ref: "a", slug: "acquisition" });
      expect(await commitsSince(WS, before)).toBe(1);
      // Only the app's own folder moved; one manifest write at most.
      const touched = await changedPaths(WS, before);
      expect(
        touched.every(
          p =>
            p.startsWith("apps/acquisition/") ||
            /^apps\/a\/.* -> apps\/acquisition\//.test(p),
        ),
      ).toBe(true);
      expect(touched).toContain(
        "apps/a/src/main.tsx -> apps/acquisition/src/main.tsx",
      );
      await expectIdentity(A_ID, {
        path: "apps/acquisition",
        title: "A",
        url: "/apps/acquisition",
        oldNames: ["a", "apps/a"],
        state,
      });
      const written = parseAppManifest(
        await fileAt(WS, "apps/acquisition/mako.json"),
        "acquisition",
      );
      // A UI rename stamps the id and writes the alias in the same commit;
      // a laptop's index remembers the alias on its own.
      expect(written.aliases).toEqual(entry.writesAlias ? ["a"] : []);
      expect((await indexed(WS, A_ID))?.aliases).toEqual(["a"]);
      expect(await othersOf(A_ID)).toEqual(others);
    });

    it.runIf(entry.title)(
      "a title-only rename writes mako.json alone and moves nothing",
      async () => {
        const before = await headOf(WS);
        await entry.rename({ ref: B_ID, title: "Billing" });
        expect(await commitsSince(WS, before)).toBe(1);
        expect(await changedPaths(WS, before)).toEqual([
          "apps/Sales/CH/b/mako.json",
        ]);
        await expectIdentity(B_ID, {
          path: "apps/Sales/CH/b",
          title: "Billing",
          url: `/apps/${B_ID}`,
          oldNames: [],
        });
        expect((await indexed(WS, B_ID))?.aliases).toEqual([]);
      },
    );

    it.runIf(entry.title)(
      "a title AND slug rename is one commit, even for an app from before ids",
      async () => {
        const A_ID = await idOf("a");
        const before = await headOf(WS);
        await entry.rename({ ref: "a", slug: "acq", title: "Acquisition" });
        expect(await commitsSince(WS, before)).toBe(1);
        await expectIdentity(A_ID, {
          path: "apps/acq",
          title: "Acquisition",
          url: "/apps/acq",
          oldNames: ["a"],
        });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe("operations", () => {
  it("files an app into another folder and into a personal tree and back: same id, visibility follows the tree", async () => {
    const A_ID = await idOf("a");
    await attachState(A_ID);
    const project = await resolveProjectRef(WS, "a");
    await moveProject(
      project!,
      { scope: "workspace", folderSegments: ["Ops"] },
      { userId: ADMIN, role: "admin" },
    );
    // Same name: index-only alias (the manifest is only stamped).
    await expectIdentity(A_ID, {
      path: "apps/Ops/a",
      url: `/apps/${A_ID}`,
      oldNames: ["apps/a"],
    });
    // The bare old link still finds it: no other app claims "a".
    expect(await idOf("a")).toBe(A_ID);
    await moveProject(
      (await resolveProjectRef(WS, A_ID))!,
      { scope: "private", ownerId: ADMIN, folderSegments: [] },
      { userId: ADMIN, role: "admin" },
    );
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: `users/${ADMIN}/apps/a`,
      access: "private",
      owner_id: ADMIN,
    });
    await moveProject(
      (await resolveProjectRef(WS, A_ID))!,
      { scope: "workspace", folderSegments: [] },
      { userId: ADMIN, role: "admin" },
    );
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: "apps/a",
      access: "workspace",
    });
    expect(await idOf("a")).toBe(A_ID);
  });

  it("renames back to a previous name: current again, the in-between name an alias, nothing listed twice", async () => {
    const A_ID = await idOf("a");
    await renameObject(admin, "app", { ref: "a", slug: "b2" });
    await renameObject(admin, "app", { ref: "b2", slug: "a" });
    expect(
      parseAppManifest(await fileAt(WS, "apps/a/mako.json"), "a").aliases,
    ).toEqual(["b2"]);
    expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
      id: A_ID,
      via: "current",
    });
    expect(await resolveObjectRef(admin, "app", "b2")).toMatchObject({
      id: A_ID,
      via: "alias",
    });
    expect((await indexed(WS, A_ID))?.aliases).toEqual(["b2"]);
  });

  it("refuses another app's live name, and a case-only variant of it, without a commit", async () => {
    const before = await headOf(WS);
    await expect(
      renameObject(admin, "app", { ref: "a", slug: "d" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      renameObject(admin, "app", { ref: "a", slug: "D" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/upper\/lower case/),
    });
    // A folder's name in another case, too (apps/sales next to apps/Sales).
    await expect(
      renameObject(admin, "app", { ref: "a", slug: "sales" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await commitsSince(WS, before)).toBe(0);
  });

  it("takes over another app's OLD name with a warning; the other app keeps its own link", async () => {
    await renameObject(admin, "app", { ref: "d", slug: "delta" });
    const A_ID = await idOf("a");
    const result = await renameObject(admin, "app", { ref: "a", slug: "d" });
    expect(result.warnings).toEqual([
      '/apps/d used to open "D" (apps/delta); it now opens "A".',
    ]);
    expect(await resolveObjectRef(admin, "app", "d")).toMatchObject({
      id: A_ID,
      via: "current",
    });
    expect(await idOf("delta")).toBe(D_ID);
    // A's own old name still answers for A.
    expect(await idOf("a")).toBe(A_ID);
  });

  it("changes the case of its own name: allowed, one commit, the old spelling an alias", async () => {
    const A_ID = await idOf("a");
    const before = await headOf(WS);
    await renameObject(admin, "app", { ref: "a", slug: "A" });
    expect(await commitsSince(WS, before)).toBe(1);
    expect(await fileAt(WS, "apps/A/mako.json")).not.toBeNull();
    expect(await fileAt(WS, "apps/a/mako.json")).toBeNull();
    await expectIdentity(A_ID, {
      path: "apps/A",
      url: "/apps/A",
      oldNames: ["a"],
    });
  });

  it("renames twice in a row (a → b → c): every old name answers, newest first", async () => {
    const A_ID = await idOf("a");
    await renameObject(admin, "app", { ref: "a", slug: "b1" });
    await renameObject(admin, "app", { ref: "a", slug: "c1" });
    await expectIdentity(A_ID, {
      path: "apps/c1",
      url: "/apps/c1",
      oldNames: ["b1", "a"],
    });
    expect((await indexed(WS, A_ID))?.aliases).toEqual(["b1", "a"]);
  });

  it("deletes then recreates at the old name: a new id; the old id is gone, not re-pointed", async () => {
    const A_ID = await idOf("a");
    await attachState(A_ID);
    await deleteProject((await resolveProjectRef(WS, "a"))!);
    expect(await resolveObjectRef(admin, "app", A_ID)).toBeNull();
    const { project } = await createProjectWith({
      workspaceId: WS,
      title: "A",
      userId: ADMIN,
    });
    const NEW = project._id.toString();
    expect(NEW).not.toBe(A_ID);
    expect(project.path).toBe("apps/a");
    expect(await idOf("a")).toBe(NEW);
    expect(await resolveObjectRef(admin, "app", A_ID)).toBeNull();
    // The new app inherits nothing of the old one's state.
    expect((await AppProject.findById(NEW).lean())?.sharedWith ?? []).toEqual(
      [],
    );
  });

  it("deletes a RENAMED app and recreates at its old name: the old link opens the new app, the deleted id nothing", async () => {
    const A_ID = await idOf("a");
    await renameObject(admin, "app", { ref: "a", slug: "a2" });
    await deleteProject((await resolveProjectRef(WS, "a2"))!);
    expect(await resolveObjectRef(admin, "app", "a")).toBeNull();
    const { project } = await createProjectWith({
      workspaceId: WS,
      title: "A",
      userId: ADMIN,
    });
    expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
      id: project._id.toString(),
      via: "current",
    });
    expect(await resolveObjectRef(admin, "app", "a2")).toBeNull();
    expect(await resolveObjectRef(admin, "app", A_ID)).toBeNull();
  });

  it("a laptop copy (cp -r) inherits neither the id nor the old names; the original keeps both", async () => {
    await renameObject(admin, "app", { ref: B_ID, slug: "billing" });
    // `cp -r` of the renamed app on a laptop, manifest (id + aliases) and all.
    await laptopPush(env, WS, async ({ dir }) => {
      await fs.cp(
        path.join(dir, "apps/Sales/CH/billing"),
        path.join(dir, "apps/Sales/CH/billing-copy"),
        { recursive: true },
      );
    });
    const snapshot = await loadAppsIndex(WS);
    const copy = snapshot.apps.find(
      a => a.path === "apps/Sales/CH/billing-copy",
    )!;
    expect(copy.appId).not.toBe(B_ID);
    expect(copy.duplicateOf).toBe(B_ID);
    expect(copy.aliases).toEqual([]);
    await expectIdentity(B_ID, {
      path: "apps/Sales/CH/billing",
      url: `/apps/${B_ID}`,
      oldNames: ["apps/Sales/CH/b", "Sales/CH/b"],
    });
    // Renaming the copy gives it an id of its own and none of B's names.
    await renameObject(admin, "app", { ref: copy.appId, slug: "b3" });
    const stamped = parseAppManifest(
      await fileAt(WS, "apps/Sales/CH/b3/mako.json"),
      "b3",
    );
    expect(stamped.id).toBe(copy.appId);
    expect(stamped.aliases).toEqual(["apps/Sales/CH/billing-copy"]);
    expect(await idOf("apps/Sales/CH/b")).toBe(B_ID);
  });

  it("renames an app in a workspace whose index was never built", async () => {
    await AppIndexEntry.deleteMany({ workspaceId: WS });
    await AppIndexHead.deleteMany({ workspaceId: WS });
    invalidateAppsIndexCache();
    const result = await renameObject(admin, "app", {
      ref: B_ID,
      slug: "billing",
    });
    expect(result.id).toBe(B_ID);
    await expectIdentity(B_ID, {
      path: "apps/Sales/CH/billing",
      url: `/apps/${B_ID}`,
      oldNames: ["apps/Sales/CH/b"],
    });
  });

  it("never commits a draft: unsaved work in the renamer's sandbox stays a draft, out of the rename commit", async () => {
    const project = (await resolveProjectRef(WS, "a"))!;
    const handle = await ensureWorktree(project, ADMIN);
    await writeFile(handle, "src/draft.ts", "export const draft = true;\n");
    const before = await headOf(WS);
    await renameObject(admin, "app", { ref: "a", slug: "acq" });
    const touched = await changedPaths(WS, before);
    expect(touched.some(p => p.includes("draft"))).toBe(false);
    expect(await fileAt(WS, "apps/acq/src/draft.ts")).toBeNull();
    expect(await fileAt(WS, "apps/a/src/draft.ts")).toBeNull();
    // The draft is still there, uncommitted, where it was written.
    expect(await readSessionFile(handle, "src/draft.ts")).toBe(
      "export const draft = true;\n",
    );
  });

  it("a `git mv` in the sandbox's terminal, pushed through Mako's git endpoint, keeps the id and the old link", async () => {
    const A_ID = await idOf("a");
    await attachState(A_ID);
    const state = await stateOf(A_ID);
    const project = (await resolveProjectRef(WS, "a"))!;
    const handle = await ensureWorktree(project, ADMIN);
    const before = await headOf(WS);
    const out = await execInWorktree(
      handle,
      'cd .. && git mv a a-terminal && git commit -q -m "mv a in the terminal"',
    );
    expect(out.exitCode, out.stderr).toBe(0);
    // execInWorktree pushes what the command committed; the endpoint's
    // push hook syncs the index.
    expect(await commitsSince(WS, before)).toBe(1);
    await expectIdentity(A_ID, {
      path: "apps/a-terminal",
      url: "/apps/a-terminal",
      oldNames: ["a"],
      state,
    });
  });

  it("a no-op rename (same title, same slug, the path as the slug) writes nothing and says so", async () => {
    const before = await headOf(WS);
    for (const request of [
      { ref: "a", slug: "a" },
      { ref: "a", title: "A" },
      { ref: "a", slug: "a", title: "A" },
      { ref: B_ID, slug: "apps/Sales/CH/b" },
      { ref: " a ", slug: " a " },
    ]) {
      const result = await renameObject(admin, "app", request);
      expect(result.warnings).toEqual([
        "Nothing to change: it already has that name.",
      ]);
      expect(result.commit).toBeUndefined();
    }
    expect(await commitsSince(WS, before)).toBe(0);
  });
});

describe("history follows the app across renames", () => {
  async function edit(rel: string, contents: string, message: string) {
    await externalCommit(WS, { [rel]: contents }, [], message);
  }

  it("keeps the commits from before a UI rename, and opens them from the app's old folder", async () => {
    await edit("apps/a/src/main.tsx", "export const a = 2;\n", "edit a");
    const A_ID = await idOf("a");
    await renameObject(admin, "app", { ref: "a", slug: "acq" });
    await edit("apps/acq/src/main.tsx", "export const a = 3;\n", "edit acq");
    const project = (await resolveProjectRef(WS, A_ID))!;
    const history = await projectHistory(scopeOf(project), 50);
    expect(history.map(c => c.subject).slice(0, 3)).toEqual([
      "edit acq",
      'Move app "A" (apps/a → apps/acq)',
      "edit a",
    ]);
    const old = history.find(c => c.subject === "edit a")!;
    // "View changes" on it: the app's own file, app-relative.
    expect((await commitChanges(scopeOf(project), old.oid)).files).toEqual([
      { path: "src/main.tsx", status: "modified" },
    ]);
    expect(
      await commitFileVersions(scopeOf(project), old.oid, "src/main.tsx"),
    ).toMatchObject({
      before: "export const a = 1;\n",
      after: "export const a = 2;\n",
    });
    // The move itself: the old folder before, the new one after.
    const move = history.find(c => c.subject.startsWith("Move app"))!;
    expect(
      await commitFileVersions(scopeOf(project), move.oid, "src/main.tsx"),
    ).toMatchObject({
      before: "export const a = 2;\n",
      after: "export const a = 2;\n",
    });
  });

  it("follows a laptop git mv that also edited a tiny manifest (git pairs nothing)", async () => {
    const T = newId();
    const tiny = (title: string) => `${JSON.stringify({ id: T, title })}\n`;
    await edit("apps/t/mako.json", tiny("T"), "create t");
    await edit("apps/t/mako.json", tiny("T, edited"), "edit t");
    await externalCommit(
      WS,
      { "apps/t2/mako.json": tiny("T2 renamed on the way") },
      ["apps/t/mako.json"],
      "laptop: mv t t2 and retitle",
    );
    const project = (await resolveProjectRef(WS, T))!;
    expect(project.path).toBe("apps/t2");
    expect(
      (await projectHistory(scopeOf(project), 50)).map(c => c.subject),
    ).toEqual(["laptop: mv t t2 and retitle", "edit t", "create t"]);
  });

  it("never shows another app's commits under an old name — neither the newcomer's in the renamed app, nor the reverse", async () => {
    await edit("apps/d/src/main.tsx", "export const d = 2;\n", "edit d before");
    await renameObject(admin, "app", { ref: "d", slug: "delta" });
    const NEW = newId();
    await edit("apps/d/mako.json", manifest("New D", NEW), "a new app at d");
    await edit("apps/d/x.ts", "export {};\n", "edit the new d");
    const renamed = (await resolveProjectRef(WS, D_ID))!;
    const own = (await projectHistory(scopeOf(renamed), 50)).map(
      c => c.subject,
    );
    expect(own).toContain("edit d before");
    expect(own).not.toContain("a new app at d");
    expect(own).not.toContain("edit the new d");
    const newcomer = (await resolveProjectRef(WS, NEW))!;
    const theirs = (await projectHistory(scopeOf(newcomer), 50)).map(
      c => c.subject,
    );
    expect(theirs).toEqual(["edit the new d", "a new app at d"]);
  });

  it("stops at the app's creation: a deleted app that held the name before is not its past", async () => {
    await edit("apps/p/mako.json", manifest("Old P", newId()), "old p");
    await edit("apps/p/x.ts", "export {};\n", "edit old p");
    await externalCommit(
      WS,
      {},
      ["apps/p/mako.json", "apps/p/x.ts"],
      "delete old p",
    );
    const P = newId();
    await edit("apps/p/mako.json", manifest("New P", P), "new p");
    await renameObject(admin, "app", { ref: "p", slug: "p2" });
    const project = (await resolveProjectRef(WS, P))!;
    expect(
      (await projectHistory(scopeOf(project), 50)).map(c => c.subject),
    ).toEqual(['Move app "New P" (apps/p → apps/p2)', "new p"]);
  });
});
