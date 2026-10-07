/**
 * App rename scenarios, part four: failure between the steps of a rename,
 * and renames racing other writers. Real git and Mongo
 * (./app-scenario-harness.ts); the one seam is `commitTree`, wrapped so a
 * test can land another writer's commit in the exact window between a
 * rename computing its change and swapping main — the window a second API
 * instance, a laptop push or a save hits in production.
 *
 *  - git commits but the Mongo row update throws; git throws and Mongo is
 *    untouched; the process "dies" after the commit, before the row; the
 *    durable mirror refuses the push (and a reader synced the index to the
 *    doomed commit meanwhile); the index write fails after the commit.
 *    Every one converges on the next read: same id, no duplicate, no
 *    orphan, nothing half-renamed.
 *  - races: two renames of one app; a rename and a save of its manifest; a
 *    rename and a laptop push into the same folder; a rename and a delete;
 *    two apps renamed onto one name; a rename and a create of one name;
 *    two creates of one title; a rename while syncs run. Never a lost
 *    write, a resurrected app, two apps in one folder, or a raw 500.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";

/** Run once, inside the next rename's commit window (see the module doc). */
const window = vi.hoisted(() => ({
  hook: null as null | ((message: string) => Promise<void>),
}));

vi.mock("../repository.service", async importOriginal => {
  const original =
    await importOriginal<typeof import("../repository.service")>();
  return {
    ...original,
    commitTree: async (
      repoDir: string,
      input: Parameters<typeof original.commitTree>[1],
    ) => {
      const hook = window.hook;
      if (hook) {
        window.hook = null;
        await hook(input.message);
      }
      return original.commitTree(repoDir, input);
    },
  };
});

import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
} from "../../database/workspace-schema";
import {
  invalidateAppsIndexCache,
  loadAppsIndex,
  syncAppsIndexFromRepo,
} from "../app-index.service";
import { parseAppManifest } from "../app-paths";
import {
  createAppFolder,
  createProjectWith,
  deleteAppFolder,
  deleteProject,
  ensureProjectRow,
  resolveProjectRef,
  stampAppId,
} from "../worktree.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { DEFAULT_BRANCH, repoDirFor } from "../repository.service";
import { runGit } from "../git";
import {
  addMember,
  commitsSince,
  externalCommit,
  fileAt,
  headOf,
  manifest,
  newId,
  resetWorkspace,
  startScenarioEnv,
  type ScenarioEnv,
} from "./app-scenario-harness";

let env: ScenarioEnv;
beforeAll(async () => {
  env = await startScenarioEnv("app-rename-races");
});
afterAll(async () => {
  await env.stop();
});

const WS = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const X_ID = newId();
const admin = { workspaceId: WS, userId: ADMIN, role: "admin" };
let A_ID: string;

beforeEach(async () => {
  window.hook = null;
  await resetWorkspace(env, WS, {
    "README.md": "workspace\n",
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": "export const a = 1;\n",
    "apps/x/mako.json": manifest("X", X_ID),
    "apps/x/src/main.tsx": "export const x = 1;\n",
  });
  await addMember(WS, ADMIN, "admin");
  const project = (await resolveProjectRef(WS, "a"))!;
  A_ID = project._id.toString();
  await ensureProjectRow(project, ADMIN);
  await AppProject.updateOne(
    { _id: project._id },
    { $set: { access: "workspace", publishedSha: "c".repeat(40) } },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
});

/** A rejection the caller can show: a RenameError with an HTTP status. */
function expectCleanRefusal(error: unknown, statuses = [404, 409]) {
  expect(error).toMatchObject({ name: "RenameError" });
  expect(statuses).toContain((error as { status: number }).status);
  // Never a server path or a raw filesystem error in what the user reads.
  expect((error as Error).message).not.toMatch(
    /ENOENT|ENOTEMPTY|\/tmp\/|lifecycle-/,
  );
}

/** One app per id, one id per folder, every row's path on main. */
async function expectConsistent() {
  invalidateAppsIndexCache();
  const snapshot = await loadAppsIndex(WS);
  const ids = snapshot.apps.map(a => a.appId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const app of snapshot.apps) {
    expect(await fileAt(WS, `${app.path}/mako.json`), app.path).not.toBeNull();
  }
  const rows = await AppProject.find({ workspaceId: WS }).lean();
  for (const row of rows) {
    const onMain = snapshot.apps.find(a => a.appId === row._id.toString());
    if (onMain) expect(row.path, row.title).toBe(onMain.path);
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Partial failure between steps
// ---------------------------------------------------------------------------

describe("partial failure", () => {
  it("the commit lands but the row update throws: the next read converges — same id, row at the new path", async () => {
    vi.spyOn(AppProject, "updateOne").mockRejectedValueOnce(
      new Error("mongo down"),
    );
    await renameObject(admin, "app", { ref: "a", slug: "a2" }).catch(
      () => undefined,
    );
    vi.restoreAllMocks();
    expect(await fileAt(WS, "apps/a2/mako.json")).not.toBeNull();
    await expectConsistent();
    expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
      id: A_ID,
      via: "alias",
      current: { path: "apps/a2" },
    });
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: "apps/a2",
      slug: "a2",
      publishedSha: "c".repeat(40),
    });
    // A retry is a no-op, not a second move.
    const before = await headOf(WS);
    await renameObject(admin, "app", { ref: "a", slug: "a2" });
    expect(await commitsSince(WS, before)).toBe(0);
  });

  it("git fails: the rename is refused and nothing in Mongo or the index moved", async () => {
    window.hook = async () => {
      throw new Error("disk full");
    };
    const before = await headOf(WS);
    await expect(
      renameObject(admin, "app", { ref: "a", slug: "a2", title: "A2" }),
    ).rejects.toThrow();
    expect(await commitsSince(WS, before)).toBe(0);
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: "apps/a",
      slug: "a",
      title: "A",
    });
    expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
      id: A_ID,
      via: "current",
    });
    expect(await resolveObjectRef(admin, "app", "a2")).toBeNull();
  });

  it("the process dies after the commit, before any row or index write: the next read converges", async () => {
    // Exactly the commit a rename writes (move + id stamped + old name as
    // an alias), landed with nothing after it.
    const raw = JSON.parse((await fileAt(WS, "apps/a/mako.json"))!) as object;
    await externalCommit(
      WS,
      {
        "apps/a2/mako.json": `${JSON.stringify({ id: A_ID, ...raw, aliases: ["a"] }, null, 2)}\n`,
        "apps/a2/src/main.tsx": "export const a = 1;\n",
      },
      ["apps/a/mako.json", "apps/a/src/main.tsx"],
      'Move app "A" (apps/a → apps/a2)',
    );
    await expectConsistent();
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: "apps/a2",
      publishedSha: "c".repeat(40),
    });
    expect((await resolveObjectRef(admin, "app", "a"))?.id).toBe(A_ID);
  });

  it("the index write fails after the commit: the rename still reports its result, and the next read converges", async () => {
    vi.spyOn(AppIndexEntry, "bulkWrite").mockRejectedValueOnce(
      new Error("mongo down"),
    );
    const result = await renameObject(admin, "app", { ref: "a", slug: "a2" });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ id: A_ID, after: { path: "apps/a2" } });
    await expectConsistent();
    expect((await resolveObjectRef(admin, "app", "a"))?.id).toBe(A_ID);
  });

  describe("the durable mirror refuses the push", () => {
    let remote: string;
    beforeEach(async () => {
      const remotes = path.join(env.tmpRoot, "remotes");
      remote = path.join(remotes, "test-owner", "test-repo.git");
      await fs.rm(remote, { recursive: true, force: true });
      await fs.mkdir(path.dirname(remote), { recursive: true });
      await runGit(["clone", "-q", "--bare", repoDirFor(WS), remote]);
      process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotes}`;
      process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    });

    async function refuseNextPush(delaySeconds = 0) {
      const hook = path.join(remote, "hooks", "pre-receive");
      await fs.writeFile(
        hook,
        `#!/bin/sh\nsleep ${delaySeconds}\necho "protected branch" >&2\nexit 1\n`,
        { mode: 0o755 },
      );
    }

    it("rolls main back and leaves the row and the index as they were", async () => {
      await refuseNextPush();
      const before = await headOf(WS);
      await expect(
        renameObject(admin, "app", { ref: "a", slug: "a2" }),
      ).rejects.toThrow(/durably/);
      expect(await headOf(WS)).toBe(before);
      await expectConsistent();
      expect(await AppProject.findById(A_ID).lean()).toMatchObject({
        path: "apps/a",
      });
      expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
        id: A_ID,
        via: "current",
      });
      expect(await resolveObjectRef(admin, "app", "a2")).toBeNull();
    });

    it("a read while the push is in flight does not index the doomed commit, and nothing of the rename is left after", async () => {
      await refuseNextPush(2);
      const before = await headOf(WS);
      const renaming = renameObject(admin, "app", {
        ref: "a",
        slug: "a2",
      }).catch((error: unknown) => error);
      // While the push hangs, another request reads the list: it sees the
      // local commit and indexes it.
      for (let i = 0; i < 100 && (await headOf(WS)) === before; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(await headOf(WS)).not.toBe(before);
      invalidateAppsIndexCache(WS);
      // Not durable yet: the read still sees the app where the mirror has it.
      expect(
        (await loadAppsIndex(WS, { freshen: false })).apps.find(
          a => a.appId === A_ID,
        )?.path,
      ).toBe("apps/a");
      expect(await renaming).toMatchObject({
        message: expect.stringMatching(/durably/),
      });
      expect(await headOf(WS)).toBe(before);
      // The rename never happened: the index, the row and every resolver
      // say so.
      invalidateAppsIndexCache(WS);
      const snapshot = await loadAppsIndex(WS, { freshen: false });
      expect(snapshot.apps.find(a => a.appId === A_ID)?.path).toBe("apps/a");
      expect(await AppProject.findById(A_ID).lean()).toMatchObject({
        path: "apps/a",
      });
      expect(await resolveObjectRef(admin, "app", "a2")).toBeNull();
      expect((await resolveProjectRef(WS, A_ID))?.path).toBe("apps/a");
    });

    it("a create whose push is refused, read meanwhile, is not left in the list", async () => {
      await refuseNextPush(2);
      const before = await headOf(WS);
      const creating = createProjectWith({
        workspaceId: WS,
        title: "Doomed",
        userId: ADMIN,
      }).catch((error: unknown) => error);
      for (let i = 0; i < 100 && (await headOf(WS)) === before; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // Not durable yet: a read meanwhile does not list it.
      invalidateAppsIndexCache(WS);
      expect(
        (await loadAppsIndex(WS, { freshen: false })).apps.some(
          a => a.path === "apps/doomed",
        ),
      ).toBe(false);
      expect(await creating).toMatchObject({
        message: expect.stringMatching(/durably/),
      });
      invalidateAppsIndexCache(WS);
      const snapshot = await loadAppsIndex(WS, { freshen: false });
      expect(snapshot.apps.some(a => a.path === "apps/doomed")).toBe(false);
      expect(await resolveObjectRef(admin, "app", "doomed")).toBeNull();
      expect(await AppProject.countDocuments({ title: "Doomed" })).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

describe("races", () => {
  it("two renames of the same app at once: one wins, the other is a clean refusal, nothing half-moved", async () => {
    let second: unknown = null;
    window.hook = async () => {
      second = await renameObject(admin, "app", { ref: "a", slug: "a-c" });
    };
    const first = await renameObject(admin, "app", {
      ref: "a",
      slug: "a-b",
    }).catch((error: unknown) => error);
    expect(second).toMatchObject({ after: { path: "apps/a-c" } });
    expectCleanRefusal(first);
    const snapshot = await expectConsistent();
    expect(snapshot.apps.find(a => a.appId === A_ID)?.path).toBe("apps/a-c");
    expect(await fileAt(WS, "apps/a-b/mako.json")).toBeNull();
    expect((await resolveObjectRef(admin, "app", "a"))?.id).toBe(A_ID);
  });

  it("a title rename racing a save of the same mako.json keeps BOTH changes", async () => {
    window.hook = async () => {
      const raw = JSON.parse((await fileAt(WS, "apps/a/mako.json"))!) as Record<
        string,
        unknown
      >;
      await externalCommit(
        WS,
        {
          "apps/a/mako.json": `${JSON.stringify({ ...raw, description: "saved meanwhile" }, null, 2)}\n`,
        },
        [],
        "save",
      );
    };
    await renameObject(admin, "app", { ref: "a", title: "Renamed" }).catch(
      (error: unknown) => expectCleanRefusal(error, [409]),
    );
    const written = parseAppManifest(await fileAt(WS, "apps/a/mako.json"), "a");
    // The save is never lost; the rename either landed on top of it or
    // was refused as a conflict.
    expect(written.description).toBe("saved meanwhile");
    expect(["Renamed", "A"]).toContain(written.title);
  });

  it("a slug rename racing a laptop push into the same folder keeps the push's edits, at the new path", async () => {
    window.hook = async () => {
      const raw = JSON.parse((await fileAt(WS, "apps/a/mako.json"))!) as Record<
        string,
        unknown
      >;
      await externalCommit(
        WS,
        {
          "apps/a/mako.json": `${JSON.stringify({ ...raw, description: "from the laptop" }, null, 2)}\n`,
          "apps/a/src/main.tsx": "export const a = 2;\n",
          "apps/a/src/new.tsx": "export const added = true;\n",
        },
        [],
        "laptop push",
      );
    };
    const outcome = await renameObject(admin, "app", {
      ref: "a",
      slug: "a2",
    }).catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expectCleanRefusal(outcome, [409]);
      expect(await fileAt(WS, "apps/a/src/new.tsx")).not.toBeNull();
    } else {
      expect(await fileAt(WS, "apps/a2/src/main.tsx")).toBe(
        "export const a = 2;\n",
      );
      expect(await fileAt(WS, "apps/a2/src/new.tsx")).not.toBeNull();
      expect(
        parseAppManifest(await fileAt(WS, "apps/a2/mako.json"), "a2")
          .description,
      ).toBe("from the laptop");
      expect(await fileAt(WS, "apps/a/mako.json")).toBeNull();
    }
    await expectConsistent();
  });

  it("a title rename racing a delete: refused, and the deleted app does NOT come back", async () => {
    window.hook = async () => {
      await externalCommit(
        WS,
        {},
        ["apps/a/mako.json", "apps/a/src/main.tsx"],
        "delete a",
      );
    };
    const outcome = await renameObject(admin, "app", {
      ref: "a",
      title: "Renamed",
    }).catch((error: unknown) => error);
    expectCleanRefusal(outcome);
    expect(await fileAt(WS, "apps/a/mako.json")).toBeNull();
    const snapshot = await expectConsistent();
    expect(snapshot.apps.some(a => a.path === "apps/a")).toBe(false);
  });

  it("a slug rename racing a delete: refused, nothing resurrected at either name", async () => {
    window.hook = async () => {
      await externalCommit(
        WS,
        {},
        ["apps/a/mako.json", "apps/a/src/main.tsx"],
        "delete a",
      );
    };
    const outcome = await renameObject(admin, "app", {
      ref: "a",
      slug: "a2",
    }).catch((error: unknown) => error);
    expectCleanRefusal(outcome);
    expect(await fileAt(WS, "apps/a2/mako.json")).toBeNull();
    expect(await fileAt(WS, "apps/a/mako.json")).toBeNull();
    await expectConsistent();
  });

  it("two apps renamed onto one free name at once: one gets it, the other is refused, no merged folder", async () => {
    let second: unknown = null;
    window.hook = async () => {
      second = await renameObject(admin, "app", { ref: "x", slug: "t" });
    };
    const first = await renameObject(admin, "app", {
      ref: "a",
      slug: "t",
    }).catch((error: unknown) => error);
    expect(second).toMatchObject({ id: X_ID, after: { path: "apps/t" } });
    expectCleanRefusal(first, [409]);
    expect(parseAppManifest(await fileAt(WS, "apps/t/mako.json"), "t").id).toBe(
      X_ID,
    );
    expect(await fileAt(WS, "apps/t/src/main.tsx")).toBe(
      "export const x = 1;\n",
    );
    expect(await fileAt(WS, "apps/a/mako.json")).not.toBeNull();
    await expectConsistent();
  });

  it("a rename and a create of the same name at once: never two apps in one folder", async () => {
    let created: unknown = null;
    window.hook = async () => {
      created = await createProjectWith({
        workspaceId: WS,
        title: "T",
        userId: ADMIN,
      }).catch((error: unknown) => error);
    };
    const renamed = await renameObject(admin, "app", {
      ref: "a",
      slug: "t",
    }).catch((error: unknown) => error);
    expect(created).toMatchObject({ project: { path: "apps/t" } });
    expectCleanRefusal(renamed, [409]);
    const snapshot = await expectConsistent();
    expect(snapshot.apps.filter(a => a.path === "apps/t").length).toBe(1);
    expect(await fileAt(WS, "apps/a/mako.json")).not.toBeNull();
  });

  it("two creates of one title at once: two apps, two folders, two rows — or a clean refusal", async () => {
    let inner: unknown = null;
    window.hook = async message => {
      if (!message.startsWith("Create app")) return;
      inner = await createProjectWith({
        workspaceId: WS,
        title: "Twin",
        userId: ADMIN,
      }).catch((error: unknown) => error);
    };
    const outer = await createProjectWith({
      workspaceId: WS,
      title: "Twin",
      userId: ADMIN,
    }).catch((error: unknown) => error);
    const outcomes = [outer, inner];
    const made = outcomes.filter(
      (o): o is { project: { path: string; _id: Types.ObjectId } } =>
        !!o && typeof o === "object" && "project" in o,
    );
    for (const o of outcomes) {
      if (!made.includes(o as (typeof made)[number])) {
        expect(o).toMatchObject({ status: 409 });
      }
    }
    expect(made.length).toBeGreaterThanOrEqual(1);
    const paths = made.map(m => m.project.path);
    expect(new Set(paths).size).toBe(paths.length);
    const snapshot = await expectConsistent();
    for (const m of made) {
      const id = m.project._id.toString();
      expect(snapshot.apps.find(a => a.appId === id)?.path).toBe(
        m.project.path,
      );
      expect(
        parseAppManifest(await fileAt(WS, `${m.project.path}/mako.json`), "")
          .id,
      ).toBe(id);
    }
  });

  it("a delete racing a rename deletes the app where it now is — never leaves it alive under its new name", async () => {
    window.hook = async message => {
      if (!message.startsWith("Delete app")) return;
      await renameObject(admin, "app", { ref: "a", slug: "a2" });
    };
    await deleteProject((await resolveProjectRef(WS, "a"))!);
    expect(await fileAt(WS, "apps/a2/mako.json")).toBeNull();
    expect(await fileAt(WS, "apps/a/mako.json")).toBeNull();
    expect(await AppProject.findById(A_ID).lean()).toBeNull();
    expect(await resolveObjectRef(admin, "app", A_ID)).toBeNull();
    await expectConsistent();
  });

  it("a delete never takes out ANOTHER app that arrived at the deleted one's old folder", async () => {
    // A's folder left main (a laptop moved it away and another app took
    // the name) but A's row still says apps/a.
    await externalCommit(
      WS,
      {
        "apps/a-moved/mako.json": manifest("A", A_ID),
        "apps/a/mako.json": manifest("Newcomer", newId()),
      },
      ["apps/a/src/main.tsx"],
      "laptop: mv a a-moved; new app at a",
    );
    const row = (await AppProject.findById(A_ID))!;
    row.path = "apps/a";
    await deleteProject(row);
    expect(await fileAt(WS, "apps/a-moved/mako.json")).toBeNull();
    expect(
      parseAppManifest(await fileAt(WS, "apps/a/mako.json"), "a").title,
    ).toBe("Newcomer");
  });

  it("a create racing a laptop push of the same folder refuses, and the pushed app is untouched", async () => {
    const LAPTOP = newId();
    window.hook = async message => {
      if (!message.startsWith("Create app")) return;
      await externalCommit(WS, {
        "apps/t/mako.json": manifest("Laptop T", LAPTOP),
        "apps/t/src/main.tsx": "export const laptop = true;\n",
      });
    };
    const outcome = await createProjectWith({
      workspaceId: WS,
      title: "T",
      userId: ADMIN,
    }).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ status: 409 });
    expect(parseAppManifest(await fileAt(WS, "apps/t/mako.json"), "t").id).toBe(
      LAPTOP,
    );
    expect(await fileAt(WS, "apps/t/src/main.tsx")).toBe(
      "export const laptop = true;\n",
    );
    expect(await fileAt(WS, "apps/t/package.json")).toBeNull();
    expect(await AppProject.countDocuments({ title: "T" })).toBe(0);
    await expectConsistent();
  });

  it("deleting an empty folder racing an app moved into it refuses — the app survives", async () => {
    await createAppFolder(WS, { scope: "workspace", folderSegments: ["Box"] });
    window.hook = async message => {
      if (!message.startsWith("Delete folder")) return;
      await renameObject(admin, "app", { ref: "x", title: "X" }).catch(
        () => undefined,
      );
      await externalCommit(
        WS,
        {
          "apps/Box/x/mako.json": (await fileAt(WS, "apps/x/mako.json"))!,
          "apps/Box/x/src/main.tsx": "export const x = 1;\n",
        },
        ["apps/x/mako.json", "apps/x/src/main.tsx"],
        "laptop: mv x Box/x",
      );
    };
    await expect(
      deleteAppFolder(WS, { scope: "workspace", folderSegments: ["Box"] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fileAt(WS, "apps/Box/x/mako.json")).not.toBeNull();
    await expectConsistent();
  });

  it("stamping a copy's id racing a save of its manifest keeps the save", async () => {
    await externalCommit(WS, {
      "apps/x-copy/mako.json": (await fileAt(WS, "apps/x/mako.json"))!,
    });
    const copy = (await loadAppsIndex(WS)).apps.find(
      a => a.path === "apps/x-copy",
    )!;
    expect(copy.duplicateOf).toBe(X_ID);
    window.hook = async () => {
      const raw = JSON.parse(
        (await fileAt(WS, "apps/x-copy/mako.json"))!,
      ) as Record<string, unknown>;
      await externalCommit(WS, {
        "apps/x-copy/mako.json": `${JSON.stringify({ ...raw, description: "saved meanwhile" }, null, 2)}\n`,
      });
    };
    await stampAppId(WS, copy);
    const written = parseAppManifest(
      await fileAt(WS, "apps/x-copy/mako.json"),
      "x-copy",
    );
    expect(written.id).toBe(copy.appId);
    expect(written.description).toBe("saved meanwhile");
  });

  it("a rename while syncs and reads run: one consistent end state", async () => {
    const work = [
      renameObject(admin, "app", { ref: "a", slug: "a2", title: "A2" }),
      ...Array.from({ length: 5 }, () => loadAppsIndex(WS)),
      syncAppsIndexFromRepo(WS, { force: true }),
      resolveObjectRef(admin, "app", "a"),
    ];
    await Promise.all(work);
    const snapshot = await expectConsistent();
    expect(snapshot.apps.find(a => a.appId === A_ID)).toMatchObject({
      path: "apps/a2",
      title: "A2",
      aliases: ["a"],
    });
    expect(
      await AppIndexHead.findOne({ workspaceId: WS }).lean(),
    ).toMatchObject({ sha: await headOf(WS) });
  });

  it("an instance whose local main is behind serves the rename another instance made, never the old state", async () => {
    const before = await headOf(WS);
    await renameObject(admin, "app", { ref: "a", slug: "a2" });
    const after = await headOf(WS);
    // This instance's clone has not fetched the rename yet.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      before,
    ]);
    invalidateAppsIndexCache();
    expect(await resolveObjectRef(admin, "app", "a")).toMatchObject({
      id: A_ID,
      via: "alias",
      current: { path: "apps/a2" },
    });
    expect(await AppProject.findById(A_ID).lean()).toMatchObject({
      path: "apps/a2",
    });
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      after,
    ]);
  });
});
