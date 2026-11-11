/**
 * renameProject: an app's name, its link, or both, as one commit on main.
 *
 * Real bare repos, a real local sandbox behind a real git endpoint, and
 * in-memory Mongo. The claims under test:
 *
 *  - ONE commit, authored by the person who renamed; a new link moves every
 *    file with its blob and mode untouched and rewrites only mako.json,
 *    where the old link is recorded so it keeps opening the app;
 *  - the commit is a compare-and-swap on what was read: a save landing in
 *    between is kept, a deleted app is never brought back, and of two
 *    renames racing one is told where the app went;
 *  - a member with unsaved work in their sandbox keeps it when someone
 *    else renames the app: it follows the app to its new folder
 *    (box-catch-up.ts; every case is in
 *    scenarios/app-rename-sandbox.scenarios.test.ts).
 *
 * The race tests run the competing change in the one window that matters:
 * after the rename has read main and decided, before its commit lands.
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

const race = vi.hoisted(() => ({
  beforeCommit: null as null | (() => Promise<void>),
}));
vi.mock("./repository.service", async importOriginal => {
  const actual = await importOriginal<typeof import("./repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      const hook = race.beforeCommit;
      race.beforeCommit = null;
      await hook?.();
      return actual.commitBlobsOnBranch(...args);
    },
  };
});

import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  AppWorktree,
  WorkspaceUserHandle,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { invalidateOwnerDirectory } from "./user-handles.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { invalidateAppsIndexCache, loadAppsIndex } from "./app-index.service";
import { parseAppManifest } from "./app-paths";
import {
  AppFolderError,
  boxCtx,
  deleteProject,
  ensureWorktree,
  execInWorktree,
  listFiles,
  readFile,
  renameProject,
  resolveProjectRef,
  writeFile,
} from "./worktree.service";
import { getSandboxProvider } from "./sandbox/provider";
import { runGit } from "./git";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-rename-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET ||= "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const ANA = new Types.ObjectId().toString();
const BEN = new Types.ObjectId().toString();
const REPORT_ID = new Types.ObjectId().toHexString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

const manifest = (fields: Record<string, unknown>) =>
  `${JSON.stringify(fields, null, 2)}\n`;

beforeEach(async () => {
  race.beforeCommit = null;
  await Promise.all([
    AppIndexEntry.deleteMany({}),
    AppIndexHead.deleteMany({}),
    AppProject.deleteMany({}),
    AppWorktree.deleteMany({}),
    WorkspaceUserHandle.deleteMany({}),
    User.deleteMany({}),
  ]);
  await User.create([
    { _id: ANA, email: "ana@example.com" },
    { _id: BEN, email: "ben@example.com" },
  ]);
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: ANA,
    handle: "ana",
  });
  invalidateOwnerDirectory();
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "sessions"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "README.md": "x\n",
    "apps/report/mako.json": manifest({
      id: REPORT_ID,
      schemaVersion: 1,
      title: "Report",
      entry: "src/main.tsx",
    }),
    "apps/report/src/main.tsx": "export const v = 1;\n",
    "apps/other/mako.json": manifest({ title: "Other" }),
    "apps/Team/legacy/mako.json": manifest({ title: "Legacy" }),
    "users/ana/apps/draft/mako.json": manifest({ title: "Draft" }),
  });
  await bindTestWorkspaceRepo(WS);
});

/** A commit from somewhere else (a laptop push, a save), straight onto main. */
async function push(
  writes: Record<string, string>,
  deletes: string[] = [],
  modes: Record<string, "100755" | "120000"> = {},
) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes, modes },
    { message: "push", author: { name: "Laptop", email: "l@example.com" } },
  );
}

const head = async () => (await resolveCommit(repoDirFor(WS), MAIN))!;

async function git(...args: string[]): Promise<string> {
  return (await runGit(["-C", repoDirFor(WS), ...args])).stdout;
}

/** `<path>` → `<mode> <blob oid>` for every file under `dir` on main. */
async function filesAt(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const record of (await git("ls-tree", "-r", "-z", MAIN, "--", dir))
    .split("\0")
    .filter(Boolean)) {
    const [meta, file] = record.split("\t");
    const [mode, , oid] = meta.split(/\s+/);
    out[file] = `${mode} ${oid}`;
  }
  return out;
}

async function manifestAt(dir: string) {
  const { contents } = await readBlob(repoDirFor(WS), MAIN, `${dir}/mako.json`);
  return parseAppManifest(contents, dir.split("/").pop() ?? dir);
}

const commitsSince = async (base: string) =>
  (await git("rev-list", `${base}..${MAIN}`)).split("\n").filter(Boolean);

const app = async (ref: string) => (await resolveProjectRef(WS, ref))!;

/** The report's state row (sharing, deployment), as a published app has. */
const reportRow = () =>
  AppProject.create({
    _id: new Types.ObjectId(REPORT_ID),
    workspaceId: new Types.ObjectId(WS),
    title: "Report",
    slug: "report",
    path: "apps/report",
    access: "workspace",
    owner_id: ANA,
    createdBy: ANA,
  });

/**
 * The report is GONE: no folder on main declares its id, at any path; its
 * row is gone; and nothing — id, current name or old link — finds it.
 */
async function expectReportGone() {
  const manifests = (await git("ls-tree", "-r", "-z", "--name-only", MAIN))
    .split("\0")
    .filter(file => file.endsWith("/mako.json"));
  for (const file of manifests) {
    const dir = file.slice(0, -"/mako.json".length);
    expect([dir, (await manifestAt(dir)).id]).not.toEqual([dir, REPORT_ID]);
  }
  expect(await filesAt("apps/report/src")).toEqual({});
  expect(await filesAt("apps/revenue")).toEqual({});
  expect(await AppProject.findById(REPORT_ID).lean()).toBeNull();
  invalidateAppsIndexCache();
  const apps = (await loadAppsIndex(WS)).apps;
  expect(apps.some(a => a.appId === REPORT_ID)).toBe(false);
  for (const ref of [REPORT_ID, "revenue", "apps/revenue"]) {
    expect([ref, await resolveProjectRef(WS, ref)]).toEqual([ref, null]);
  }
}

describe("renaming an app", () => {
  it("a new name is one commit by the person renaming, touching only mako.json", async () => {
    const base = await head();
    const result = await renameProject(
      await app(REPORT_ID),
      { title: "  Revenue report " },
      { userId: ANA },
    );
    expect(result).toMatchObject({
      from: "apps/report",
      to: "apps/report",
      title: "Revenue report",
      aliasesAdded: [],
    });
    expect(await commitsSince(base)).toEqual([result.commit]);
    expect((await git("log", "-1", "--format=%an <%ae>|%s", MAIN)).trim()).toBe(
      'ana <ana@example.com>|Rename app "Report" to "Revenue report" (apps/report)',
    );
    expect(
      (await git("diff", "--name-only", base, MAIN)).trim().split("\n"),
    ).toEqual(["apps/report/mako.json"]);
    const after = await manifestAt("apps/report");
    expect(after).toMatchObject({ id: REPORT_ID, title: "Revenue report" });
    expect(after.aliases).toEqual([]);
    expect(Object.keys(after.raw)).toEqual([
      "id",
      "schemaVersion",
      "title",
      "entry",
    ]);
    expect((await app("report")).title).toBe("Revenue report");
  });

  it("a new link moves every file as it is and keeps the old link working", async () => {
    await push(
      {
        "apps/report/run.sh": "#!/bin/sh\necho hi\n",
        "apps/report/latest": "src/main.tsx",
      },
      [],
      { "apps/report/run.sh": "100755", "apps/report/latest": "120000" },
    );
    const row = await AppProject.create({
      _id: new Types.ObjectId(REPORT_ID),
      workspaceId: new Types.ObjectId(WS),
      title: "Report",
      slug: "report",
      path: "apps/report",
      access: "workspace",
      owner_id: ANA,
      createdBy: ANA,
      publishedSha: "f".repeat(40),
    });
    const before = await filesAt("apps/report");
    const base = await head();

    const result = await renameProject(
      await app(REPORT_ID),
      { slug: "revenue" },
      { userId: BEN },
    );
    expect(result).toMatchObject({
      from: "apps/report",
      to: "apps/revenue",
      title: "Report",
      aliasesAdded: ["report"],
    });
    expect(await commitsSince(base)).toEqual([result.commit]);
    expect((await git("log", "-1", "--format=%ae|%s", MAIN)).trim()).toBe(
      'ben@example.com|Rename app "Report" (apps/report → apps/revenue)',
    );
    // Every file but the manifest: same blob, same mode (the script stays
    // executable, the symlink stays a symlink), nothing left behind.
    const after = await filesAt("apps/revenue");
    const moved = (files: Record<string, string>, root: string) =>
      Object.fromEntries(
        Object.entries(files)
          .filter(([file]) => !file.endsWith("/mako.json"))
          .map(([file, at]) => [file.slice(root.length + 1), at]),
      );
    expect(moved(after, "apps/revenue")).toEqual(moved(before, "apps/report"));
    expect(after["apps/revenue/run.sh"]).toMatch(/^100755 /);
    expect(after["apps/revenue/latest"]).toMatch(/^120000 /);
    expect(await filesAt("apps/report")).toEqual({});
    expect(await manifestAt("apps/revenue")).toMatchObject({
      id: REPORT_ID,
      title: "Report",
      aliases: ["report"],
    });
    // Same app: its row (sharing, deployment) follows it, and the old link,
    // the old path and the id all still name it.
    expect(await AppProject.findById(row._id).lean()).toMatchObject({
      path: "apps/revenue",
      slug: "revenue",
      owner_id: ANA,
      publishedSha: "f".repeat(40),
    });
    for (const ref of ["report", "apps/report", "revenue", REPORT_ID]) {
      expect([ref, (await app(ref))?._id.toString()]).toEqual([ref, REPORT_ID]);
    }
  });

  it("both at once are still one commit; no change is no commit", async () => {
    const base = await head();
    const result = await renameProject(
      await app(REPORT_ID),
      { title: "Revenue", slug: "revenue" },
      { userId: ANA },
    );
    expect(await commitsSince(base)).toEqual([result.commit]);
    expect((await git("log", "-1", "--format=%s", MAIN)).trim()).toBe(
      'Rename app "Report" to "Revenue" (apps/report → apps/revenue)',
    );
    expect(await manifestAt("apps/revenue")).toMatchObject({
      title: "Revenue",
      aliases: ["report"],
    });
    const again = await renameProject(
      await app(REPORT_ID),
      { title: "Revenue", slug: "revenue" },
      { userId: ANA },
    );
    expect(again.commit).toBeUndefined();
    expect(await commitsSince(base)).toHaveLength(1);
  });

  it("renamed back, the name is current again: never listed as its own old link", async () => {
    await renameProject(await app(REPORT_ID), { slug: "revenue" });
    await renameProject(await app(REPORT_ID), { slug: "income" });
    expect((await manifestAt("apps/income")).aliases).toEqual([
      "report",
      "revenue",
    ]);
    await renameProject(await app(REPORT_ID), { slug: "report" });
    expect((await manifestAt("apps/report")).aliases).toEqual([
      "revenue",
      "income",
    ]);
    expect((await app("income"))._id.toString()).toBe(REPORT_ID);
  });

  it("keeps the newest 24 old links", async () => {
    const old = Array.from({ length: 24 }, (_, i) => `v${i}`);
    await push({
      "apps/report/mako.json": manifest({
        id: REPORT_ID,
        title: "Report",
        aliases: old,
      }),
    });
    await renameProject(await app(REPORT_ID), { slug: "revenue" });
    expect((await manifestAt("apps/revenue")).aliases).toEqual([
      ...old.slice(1),
      "report",
    ]);
    expect(await resolveProjectRef(WS, "v0")).toBeNull();
    expect((await app("v1"))._id.toString()).toBe(REPORT_ID);
  });

  it("a nested or personal app records its old PATH, and an app without an id gets its own stamped", async () => {
    const legacy = await app("apps/Team/legacy");
    const legacyId = legacy._id.toString();
    await renameProject(legacy, { slug: "modern" }, { userId: ANA });
    expect(await manifestAt("apps/Team/modern")).toMatchObject({
      id: legacyId,
      aliases: ["apps/Team/legacy"],
    });
    expect((await app("Team/legacy"))._id.toString()).toBe(legacyId);
    // A nested app never had `/apps/legacy` as its link: the bare name
    // stays free for whoever takes it.
    expect(await resolveProjectRef(WS, "legacy")).toBeNull();

    const draft = await app("users/ana/apps/draft");
    const renamed = await renameProject(
      draft,
      { slug: "plan" },
      { userId: ANA },
    );
    expect(renamed.to).toBe("users/ana/apps/plan");
    expect((await app("users/ana/apps/draft"))._id).toEqual(draft._id);
  });

  it("refuses a link that is taken, differs only in case, or is not a link — and commits nothing", async () => {
    const base = await head();
    const report = await app(REPORT_ID);
    const refusal = (slug: string) =>
      renameProject(report, { slug }).then(
        () => null,
        (error: unknown) =>
          error instanceof AppFolderError
            ? `${error.status} ${error.message}`
            : String(error),
      );
    expect(await refusal("other")).toBe(
      "409 The link /apps/other is already taken. Pick another.",
    );
    expect(await refusal("Other")).toMatch(/^409 .*upper and lower case/);
    // Its own link in another case: the same folder to a checkout on macOS
    // or Windows, so it is refused rather than half-applied there.
    expect(await refusal("Report")).toBe(
      '400 "Report" differs from the current link only in upper and lower case, which macOS and Windows can\'t tell apart. Pick a different link.',
    );
    // A folder holds the name just as an app would.
    expect(await refusal("Team")).toBe(
      "409 The link /apps/Team is already taken. Pick another.",
    );
    expect(await refusal("a/b")).toMatch(/^400 Use only letters/);
    expect(await refusal("con")).toMatch(/^400 .*Windows/);
    expect(await refusal("search")).toMatch(/^400 .*reserved/);
    expect(await refusal(REPORT_ID)).toMatch(/^400 .*app id/);
    expect(await refusal("x".repeat(101))).toMatch(/^400 .*100 characters/);
    await expect(renameProject(report, { title: " ​ " })).rejects.toMatchObject(
      { status: 400 },
    );
    expect(await commitsSince(base)).toEqual([]);

    await push({ "apps/report/mako.json": "{ not json" });
    await expect(
      renameProject(await app("report"), { title: "New" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/isn't valid JSON/),
    });
    expect(
      (await readBlob(repoDirFor(WS), MAIN, "apps/report/mako.json")).contents,
    ).toBe("{ not json");
  });
});

describe("a rename racing another change", () => {
  it("a save landing first is kept: its edit arrives at the new link", async () => {
    race.beforeCommit = () =>
      push({
        "apps/report/src/main.tsx": "export const v = 2;\n",
        "apps/report/src/new.ts": "export {};\n",
      });
    const result = await renameProject(await app(REPORT_ID), {
      slug: "revenue",
    });
    expect(result.to).toBe("apps/revenue");
    const at = (file: string) =>
      readBlob(repoDirFor(WS), MAIN, file).then(b => b.contents);
    expect(await at("apps/revenue/src/main.tsx")).toBe("export const v = 2;\n");
    expect(await at("apps/revenue/src/new.ts")).toBe("export {};\n");
    expect(await filesAt("apps/report")).toEqual({});
  });

  it("a save of mako.json landing first is kept by a new name", async () => {
    race.beforeCommit = () =>
      push({
        "apps/report/mako.json": manifest({
          id: REPORT_ID,
          title: "Report",
          description: "Saved meanwhile",
        }),
      });
    await renameProject(await app(REPORT_ID), { title: "Revenue" });
    expect(await manifestAt("apps/report")).toMatchObject({
      title: "Revenue",
      description: "Saved meanwhile",
    });
  });

  it.each([
    ["a new name", { title: "Revenue" }],
    ["a new link", { slug: "revenue" }],
  ])(
    "a delete landing after the rename's read wins: %s answers 404 and brings nothing back",
    async (_what, change) => {
      await reportRow();
      const report = await app(REPORT_ID);
      let deleted = false;
      race.beforeCommit = async () => {
        await deleteProject(await app(REPORT_ID));
        deleted = true;
      };
      await expect(renameProject(report, change)).rejects.toMatchObject({
        status: 404,
      });
      expect(deleted).toBe(true);
      await expectReportGone();
    },
  );

  it.each([
    ["a new link", { slug: "revenue" }],
    ["a new name", { title: "Revenue" }],
    ["both", { title: "Revenue", slug: "revenue" }],
  ])(
    "a rename landing after the delete's read: %s lands, and the delete still removes the app where it now is",
    async (_what, change) => {
      await reportRow();
      // What DELETE /apps/{id} holds: the app as it was when the route read it.
      const read = await app(REPORT_ID);
      let renamedTo: string | undefined;
      race.beforeCommit = async () => {
        renamedTo = (await renameProject(await app(REPORT_ID), change)).to;
      };
      await deleteProject(read);
      // Both said "done" — so the app must be gone, wherever the rename put it.
      expect(renamedTo).toBe("slug" in change ? "apps/revenue" : "apps/report");
      await expectReportGone();
    },
  );

  it("a delete holding a path from BEFORE a rename removes the renamed app, never a newcomer at the old folder", async () => {
    await reportRow();
    const read = await app(REPORT_ID);
    await renameProject(await app(REPORT_ID), { slug: "revenue" });
    await push({ "apps/report/mako.json": manifest({ title: "Newcomer" }) });
    await deleteProject(read);
    await expectReportGone();
    expect((await manifestAt("apps/report")).title).toBe("Newcomer");
    // Deleting it again is a no-op, not an error and not the newcomer's end.
    await deleteProject(read);
    expect((await manifestAt("apps/report")).title).toBe("Newcomer");
  });

  it("a save landing after the delete's read does not keep the app alive", async () => {
    await reportRow();
    race.beforeCommit = () =>
      push({ "apps/report/src/main.tsx": "export const v = 3;\n" });
    await deleteProject(await app(REPORT_ID));
    await expectReportGone();
  });

  it("of two renames, the second is told where the app went", async () => {
    const report = await app(REPORT_ID);
    race.beforeCommit = async () => {
      await renameProject(await app(REPORT_ID), { slug: "income" });
    };
    await expect(
      renameProject(report, { slug: "revenue" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/apps\/income/),
    });
    expect(Object.keys(await filesAt("apps/revenue"))).toEqual([]);
    expect((await manifestAt("apps/income")).aliases).toEqual(["report"]);

    // And at the same instant: exactly one lands, nothing is half-moved.
    const [a, b] = await Promise.allSettled([
      renameProject(await app(REPORT_ID), { slug: "left" }),
      renameProject(await app(REPORT_ID), { slug: "right" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const apps = (await loadAppsIndex(WS)).apps.filter(
      x => x.appId === REPORT_ID,
    );
    expect(apps).toHaveLength(1);
    expect(Object.keys(await filesAt("apps/income"))).toEqual([]);
  });

  it("an app arriving at the new link first keeps it", async () => {
    race.beforeCommit = () =>
      push({ "apps/revenue/mako.json": manifest({ title: "Newcomer" }) });
    await expect(
      renameProject(await app(REPORT_ID), { slug: "revenue" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await manifestAt("apps/revenue")).title).toBe("Newcomer");
    expect((await manifestAt("apps/report")).title).toBe("Report");
  });
});

describe("a member's sandbox with unsaved work, after someone else renames the app", () => {
  /** Ana's sandbox: the box's own git, where her unsaved work lives. */
  async function box(report: Awaited<ReturnType<typeof app>>) {
    const handle = await ensureWorktree(report, ANA);
    const run = async (command: string) => {
      const result = await execInWorktree(handle, command, { cwd: ".." });
      return { code: result.exitCode, out: result.stdout.trim() };
    };
    return { handle, run };
  }

  it("an unsaved EDIT follows the app: she sees her edit under the new link, and her next save lands beside every other file", async () => {
    const report = await app(REPORT_ID);
    const { handle, run } = await box(report);
    await writeFile(handle, "src/main.tsx", "export const v = 'ana';\n");

    await renameProject(
      await app(REPORT_ID),
      { slug: "revenue" },
      { userId: BEN },
    );
    const renamed = await app(REPORT_ID);

    // What the app shows her now: her own edit, in the renamed app. (Before
    // the catch-up carried drafts, git refused the merge over her edit: the
    // sandbox kept the old folder and she was shown main's file instead.)
    expect((await readFile(renamed, "src/main.tsx", ANA)).contents).toBe(
      "export const v = 'ana';\n",
    );
    // Her sandbox caught up: the app is in its new folder, the edit is
    // still hers alone (uncommitted), and no old folder is left.
    expect((await run("git rev-parse HEAD")).out).toBe(await head());
    expect((await run("test -e report && echo yes || echo no")).out).toBe("no");
    expect((await run("git status --porcelain")).out).toBe(
      "M apps/revenue/src/main.tsx",
    );
    // Nothing of hers reached main.
    expect(await git("show", `${MAIN}:apps/revenue/src/main.tsx`)).toBe(
      "export const v = 1;\n",
    );

    // Then she saves a file through the app. It lands in the app's folder,
    // beside every other file. (Before, it landed in a new folder holding
    // nothing else, and the app listed only that one file.)
    await writeFile(
      await ensureWorktree(renamed, ANA),
      "src/after.ts",
      "export {};\n",
    );
    expect(
      (await listFiles(renamed, ANA)).entries.map(e => e.path).sort(),
    ).toEqual(["mako.json", "src/after.ts", "src/main.tsx"]);
    expect((await run("git status --porcelain")).out).toBe(
      "M apps/revenue/src/main.tsx\n?? apps/revenue/src/after.ts",
    );
    await getSandboxProvider().destroySession?.(boxCtx(handle).sessionKey);
  });

  it("an unsaved NEW file follows the app: it is listed under the new link, and nothing is left in the old folder", async () => {
    const report = await app(REPORT_ID);
    const { handle, run } = await box(report);
    await writeFile(handle, "src/notes.ts", "export const n = 1;\n");

    await renameProject(
      await app(REPORT_ID),
      { slug: "revenue" },
      { userId: BEN },
    );
    const renamed = await app(REPORT_ID);

    // The app's file list has her new file. (Before, the merge moved the
    // tracked files and left this one behind in a stray old folder.)
    expect(
      (await listFiles(renamed, ANA)).entries.map(e => e.path).sort(),
    ).toEqual(["mako.json", "src/main.tsx", "src/notes.ts"]);
    expect((await readFile(renamed, "src/notes.ts", ANA)).contents).toBe(
      "export const n = 1;\n",
    );
    expect((await run("test -e report && echo yes || echo no")).out).toBe("no");
    expect((await run("git status --porcelain")).out).toBe(
      "?? apps/revenue/src/notes.ts",
    );
    await getSandboxProvider().destroySession?.(boxCtx(handle).sessionKey);
  });
});
