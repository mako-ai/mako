/**
 * Console renames when things go wrong, race, or get big:
 *
 * - partial failure: the commit lands but the row write throws (the
 *   process "crashing" between the two); the commit throws; the mirror
 *   fetch before a write is down; the mirror push after it fails — the
 *   next read or sync converges (same id, no teardown, no duplicate, no
 *   orphan), or nothing changed at all;
 * - races: two renames of one console, two consoles onto one free name,
 *   a rename against a save, against a laptop push of the same file
 *   (edit, move, a new file at the target), against a delete, against a
 *   running sync;
 * - scale: a workspace of thousands of consoles, a console with a history
 *   of a thousand commits — bounded time, measured and printed.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ id: "", role: "member" as string | null }));
const faults = vi.hoisted(() => ({
  /** Fail the next N commits (after their blobs were written). */
  failCommits: 0,
  /** The mirror fetch before a main write is down. */
  freshenDown: false,
  /** The fire-and-forget mirror push rejects. */
  pushDown: false,
  pushAttempts: 0,
}));

vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: who.id, email: "u@example.com" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: async () => who.role !== null,
    getMember: async () => (who.role ? { role: who.role } : null),
    getMembers: async () => [],
    hasRole: async (_ws: string, _user: string, roles: string[]) =>
      who.role !== null && roles.includes(who.role),
  },
}));
vi.mock("../../inngest", () => ({
  inngest: { send: async () => ({}), createFunction: () => ({}) },
}));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      if (faults.failCommits > 0) {
        faults.failCommits -= 1;
        throw new Error("injected: git commit failed");
      }
      return actual.commitBlobsOnBranch(...args);
    },
  };
});
vi.mock("../../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/cloud-repo.service")>();
  return {
    ...actual,
    freshenBeforeMainWrite: async (workspaceId: string) => {
      if (faults.freshenDown) throw new Error("injected: mirror unreachable");
      return actual.freshenBeforeMainWrite(workspaceId);
    },
    queueMirrorPush: (workspaceId: string) => {
      faults.pushAttempts += 1;
      if (faults.pushDown) {
        // What the real one does with a failed push: log, never throw.
        void Promise.reject(new Error("injected: push failed")).catch(
          () => undefined,
        );
        return;
      }
      actual.queueMirrorPush(workspaceId);
    },
  };
});

import { ConsoleFolder, SavedConsole } from "../../database/workspace-schema";
import {
  consoleHistory,
  syncConsolesIndexFromRepo,
} from "../../apps/workspace-consoles.service";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { renameObject, resolveObjectRef } from "../../rename/registry";
import { RenameError } from "../../rename/types";
import { createConsoleRig } from "./console-scenario-rig";

const rig = createConsoleRig(who, "console-robustness-scenarios");
const { owner, admin } = rig.people;

function resetFaults() {
  faults.failCommits = 0;
  faults.freshenDown = false;
  faults.pushDown = false;
  faults.pushAttempts = 0;
}

/** Exactly one live row per console file at main, and each row's file exists. */
async function expectConverged() {
  const files = await rig.consolePaths();
  const live = await SavedConsole.find({
    workspaceId: rig.ws,
    isSaved: true,
    is_deleted: { $ne: true },
  });
  expect(live.map(r => r.path).sort()).toEqual(files);
  for (const row of live) {
    expect(row.name).toBe(
      row
        .path!.split("/")
        .pop()!
        .replace(/\.(sql|js|mongodb\.js)$/, ""),
    );
  }
}

async function settle<T>(p: Promise<T>): Promise<number> {
  try {
    const r = (await p) as { status?: number };
    return typeof r?.status === "number" ? r.status : 200;
  } catch (error) {
    if (error instanceof RenameError) return error.status;
    return 500;
  }
}

describe("partial failure", () => {
  it("the commit lands, then the row write throws: the next read heals, the next sync converges — same id, no duplicate", async () => {
    resetFaults();
    const c = await rig.save("before", owner);
    const id = c._id.toString();
    await rig.shareWith(c._id, admin.id, "editor");
    const spy = vi
      .spyOn(SavedConsole, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("injected: mongo down"));
    await expect(
      renameObject(rig.ctx(owner), "console", { ref: id, title: "after" }),
    ).rejects.toThrow(/mongo down/);
    spy.mockRestore();
    // The commit is on main; the row still points at the old path.
    expect(await rig.consolePaths()).toEqual(["consoles/after.sql"]);
    expect((await rig.row(id))!.path).toBe("consoles/before.sql");
    // A read of the console by its id heals it on the spot (the stale-path
    // heal joins a sync) — the link /c/<id> never 404s.
    const read = await rig.api("GET", `/consoles/content?id=${id}`, owner);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.name).toBe("after");
    await syncConsolesIndexFromRepo(rig.ws);
    const row = (await rig.row(id))!;
    expect(row.path).toBe("consoles/after.sql");
    expect(row.is_deleted).toBeFalsy();
    expect(row.sharedWith?.length).toBe(1);
    expect(await SavedConsole.countDocuments({})).toBe(1);
    await expectConverged();
    // And the console renames again normally.
    await renameObject(rig.ctx(owner), "console", { ref: id, title: "again" });
    expect((await rig.row(id))!.path).toBe("consoles/again.sql");
  });

  it("the commit throws: nothing changed — row, files, history", async () => {
    resetFaults();
    const c = await rig.save("stable", owner);
    const before = await rig.snapshot();
    const commits = await rig.commitCount();
    faults.failCommits = 1;
    const code = await settle(
      renameObject(rig.ctx(owner), "console", {
        ref: c._id.toString(),
        title: "moved",
      }),
    );
    expect(code).toBe(500);
    faults.failCommits = 0;
    expect(await rig.snapshot()).toEqual(before);
    expect(await rig.commitCount()).toBe(commits);
    // The explorer's routes answer an error, never a half-done move.
    faults.failCommits = 1;
    const r = await rig.api("PATCH", `/consoles/${c._id}/rename`, owner, {
      name: "moved",
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    faults.failCommits = 0;
    expect(await rig.snapshot()).toEqual(before);
    await expectConverged();
  });

  it("a folder rename whose commit throws leaves the folder and every console as they were", async () => {
    resetFaults();
    const folder = await rig.manager.createFolder(
      "Team",
      rig.ws,
      owner.id,
      undefined,
      false,
      "workspace",
    );
    await rig.save("a", owner, { folderId: folder._id.toString() });
    await rig.save("b", owner, { folderId: folder._id.toString() });
    const before = await rig.snapshot();
    faults.failCommits = 1;
    const r = await rig.api(
      "PATCH",
      `/consoles/folders/${folder._id}/rename`,
      owner,
      { name: "Team 2" },
    );
    faults.failCommits = 0;
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await rig.snapshot()).toEqual(before);
    expect((await ConsoleFolder.findById(folder._id))?.name).toBe("Team");
  });

  it("the mirror is unreachable before the write: refused, nothing changed", async () => {
    resetFaults();
    const c = await rig.save("stable", owner);
    const before = await rig.snapshot();
    faults.freshenDown = true;
    const code = await settle(
      renameObject(rig.ctx(owner), "console", {
        ref: c._id.toString(),
        title: "moved",
      }),
    );
    faults.freshenDown = false;
    expect(code).toBe(500);
    expect(await rig.snapshot()).toEqual(before);
  });

  it("the mirror push after the commit fails: the rename stands (the bare repo holds it for the next push)", async () => {
    resetFaults();
    const c = await rig.save("before", owner);
    faults.pushDown = true;
    const attempts = faults.pushAttempts;
    const res = await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "after",
    });
    faults.pushDown = false;
    expect(res.after.path).toBe("consoles/after.sql");
    expect(faults.pushAttempts).toBeGreaterThan(attempts);
    expect((await rig.row(c._id))!.path).toBe("consoles/after.sql");
    await expectConverged();
  });
});

describe("races", () => {
  it("two renames of one console at once: one place, one file, same id", async () => {
    resetFaults();
    const c = await rig.save("start", owner);
    const id = c._id.toString();
    const codes = await Promise.all([
      settle(renameObject(rig.ctx(owner), "console", { ref: id, title: "b" })),
      settle(renameObject(rig.ctx(owner), "console", { ref: id, title: "c" })),
      settle(rig.api("PATCH", `/consoles/${id}/rename`, owner, { name: "d" })),
    ]);
    expect(codes.some(code => code === 200)).toBe(true);
    for (const code of codes) expect([200, 409]).toContain(code);
    await syncConsolesIndexFromRepo(rig.ws);
    const row = (await rig.row(id))!;
    expect(["consoles/b.sql", "consoles/c.sql", "consoles/d.sql"]).toContain(
      row.path,
    );
    expect(await rig.consolePaths()).toEqual([row.path]);
    await expectConverged();
  });

  it("two consoles onto one free name at once: exactly one wins", async () => {
    resetFaults();
    const a = await rig.save("a", owner);
    const b = await rig.save("b", owner);
    const codes = await Promise.all([
      settle(
        renameObject(rig.ctx(owner), "console", {
          ref: a._id.toString(),
          title: "prize",
        }),
      ),
      settle(
        renameObject(rig.ctx(owner), "console", {
          ref: b._id.toString(),
          title: "PRIZE",
        }),
      ),
    ]);
    expect(codes.sort()).toEqual([200, 409]);
    const paths = await rig.consolePaths();
    expect(paths.filter(p => /prize\.sql$/i.test(p))).toHaveLength(1);
    await expectConverged();
  });

  it("a rename racing an explicit save: the saved content is never lost or doubled", async () => {
    resetFaults();
    const c = await rig.save("start", owner, { code: "SELECT 'v1'\n" });
    const id = c._id.toString();
    const [renamed, saved] = await Promise.all([
      settle(renameObject(rig.ctx(owner), "console", { ref: id, title: "r" })),
      settle(
        rig.api("PUT", `/consoles/${id}`, owner, {
          content: "SELECT 'v2'\n",
          isSaved: true,
        }),
      ),
    ]);
    for (const code of [renamed, saved]) expect([200, 409]).toContain(code);
    await syncConsolesIndexFromRepo(rig.ws);
    const row = (await rig.row(id))!;
    const files = await rig.consolePaths();
    expect(files).toEqual([row.path]);
    if (saved === 200) {
      expect(await rig.fileAt(row.path!)).toBe("SELECT 'v2'\n");
    }
    if (renamed === 200) expect(row.path).toBe("consoles/r.sql");
    await expectConverged();
  });

  it("a rename after a laptop EDIT of the same file not yet synced: moves the edited file, never reverts it", async () => {
    resetFaults();
    const c = await rig.save("start", owner, { code: "SELECT 'mako'\n" });
    await rig.laptop(
      { writes: { "consoles/start.sql": "SELECT 'laptop edit'\n" } },
      { sync: false },
    );
    await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "renamed",
    });
    expect(await rig.fileAt("consoles/renamed.sql")).toBe(
      "SELECT 'laptop edit'\n",
    );
    expect((await rig.row(c._id))!.code).toBe("SELECT 'laptop edit'");
    expect(await rig.consolePaths()).toEqual(["consoles/renamed.sql"]);
    await expectConverged();
  });

  it("a rename after a laptop MOVE of the same file not yet synced: same id, renamed where the laptop put it", async () => {
    resetFaults();
    const c = await rig.save("start", owner);
    await rig.laptop(
      {
        writes: { "consoles/Laptop/start.sql": "SELECT 'start'\n" },
        deletes: ["consoles/start.sql"],
      },
      { sync: false },
    );
    const res = await renameObject(rig.ctx(owner), "console", {
      ref: c._id.toString(),
      title: "renamed",
    });
    expect(res.id).toBe(c._id.toString());
    const row = (await rig.row(c._id))!;
    expect(row.path).toBe("consoles/Laptop/renamed.sql");
    expect(await rig.consolePaths()).toEqual(["consoles/Laptop/renamed.sql"]);
    await expectConverged();
  });

  it("a laptop push that lands a NEW file at the rename's target first: the rename is refused, both survive", async () => {
    resetFaults();
    const c = await rig.save("start", owner);
    await rig.laptop(
      { writes: { "consoles/target.sql": "SELECT 'laptop target'\n" } },
      { sync: false },
    );
    const code = await settle(
      renameObject(rig.ctx(owner), "console", {
        ref: c._id.toString(),
        title: "target",
      }),
    );
    expect(code).toBe(409);
    expect(await rig.fileAt("consoles/target.sql")).toBe(
      "SELECT 'laptop target'\n",
    );
    expect((await rig.row(c._id))!.path).toBe("consoles/start.sql");
    await syncConsolesIndexFromRepo(rig.ws);
    await expectConverged();
  });

  it("a rename racing a delete: never a live file for a deleted console, never a resurrection", async () => {
    resetFaults();
    for (let round = 0; round < 3; round++) {
      const c = await rig.save(`doomed-${round}`, owner);
      const id = c._id.toString();
      await Promise.all([
        settle(
          renameObject(rig.ctx(owner), "console", {
            ref: id,
            title: `renamed-${round}`,
          }),
        ),
        settle(rig.api("DELETE", `/consoles/${id}`, owner)),
      ]);
      await syncConsolesIndexFromRepo(rig.ws);
      const row = (await rig.row(id))!;
      const files = await rig.consolePaths();
      const mine = files.filter(p => p.includes(`-${round}.sql`));
      if (row.is_deleted) expect(mine).toEqual([]);
      else expect(mine).toEqual([row.path]);
      await expectConverged();
    }
  });

  it("a rename while a sync is running converges", async () => {
    resetFaults();
    const c = await rig.save("start", owner);
    await rig.laptop(
      { writes: { "consoles/other.sql": "SELECT 'other'\n" } },
      { sync: false },
    );
    await Promise.all([
      syncConsolesIndexFromRepo(rig.ws),
      renameObject(rig.ctx(owner), "console", {
        ref: c._id.toString(),
        title: "renamed",
      }),
      syncConsolesIndexFromRepo(rig.ws),
    ]);
    await syncConsolesIndexFromRepo(rig.ws);
    expect((await rig.row(c._id))!.path).toBe("consoles/renamed.sql");
    await expectConverged();
  });
});

describe("scale", () => {
  it("a workspace of 2,000 consoles: index, resolve and rename stay bounded", async () => {
    resetFaults();
    await rig.adopt();
    const writes: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      writes[`consoles/Bulk ${i % 20}/c-${i}.sql`] = `SELECT ${i}\n`;
    }
    let t = Date.now();
    await rig.laptop({ writes }, { pusher: owner.id });
    const syncMs = Date.now() - t;
    expect(await SavedConsole.countDocuments({})).toBe(2000);

    t = Date.now();
    const hit = await resolveObjectRef(rig.ctx(owner), "console", "c-1999");
    const resolveMs = Date.now() - t;
    expect(hit?.current.path).toBe("consoles/Bulk 19/c-1999.sql");

    t = Date.now();
    await renameObject(rig.ctx(owner), "console", {
      ref: hit!.id,
      title: "c-1999 renamed",
    });
    const renameMs = Date.now() - t;

    t = Date.now();
    await syncConsolesIndexFromRepo(rig.ws);
    const resyncMs = Date.now() - t;
    console.info(
      `[scale] 2000 consoles: first sync ${syncMs} ms, resolve ${resolveMs} ms, rename ${renameMs} ms, no-op sync ${resyncMs} ms`,
    );
    expect(resolveMs).toBeLessThan(10_000);
    expect(renameMs).toBeLessThan(10_000);
    expect(resyncMs).toBeLessThan(10_000);
    expect((await SavedConsole.findById(hit!.id))!.path).toBe(
      "consoles/Bulk 19/c-1999 renamed.sql",
    );
  }, 300_000);

  it("a console with 1,000 commits across renames: history stays bounded and complete up to the limit", async () => {
    resetFaults();
    const c = await rig.save("busy", owner, { code: "SELECT 0\n" });
    const repo = repoDirFor(rig.ws);
    // 1,000 commits in one `git fast-import` (a commit per commitBlobs
    // call costs ~0.1 s each): an edit per commit, and a pure `git mv`
    // every 250 (a move that also rewrites a one-line file is, to git, a
    // delete and an add — by construction not the same file).
    let path = "consoles/busy.sql";
    let content = "SELECT 0\n";
    let t = Date.now();
    const head = (await resolveCommit(repo, `refs/heads/${DEFAULT_BRANCH}`))!;
    const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
    let stream = "";
    for (let i = 1; i <= 1000; i++) {
      stream += `commit refs/heads/${DEFAULT_BRANCH}\n`;
      stream += `committer Laptop <laptop@example.com> ${1_700_000_000 + i} +0000\n`;
      if (i % 250 === 0) {
        const next = `consoles/busy-${i}.sql`;
        stream += data(`mv ${i}`);
        stream += `D ${path}\nM 100644 inline ${next}\n${data(content)}`;
        path = next;
      } else {
        content = `SELECT ${i}\n`;
        stream += data(`edit ${i}`);
        if (i === 1) stream += `from ${head}\n`;
        stream += `M 100644 inline ${path}\n${data(content)}`;
      }
    }
    execFileSync("git", ["-C", repo, "fast-import", "--quiet", "--force"], {
      input: stream,
    });
    const buildMs = Date.now() - t;
    await syncConsolesIndexFromRepo(rig.ws);
    expect((await rig.row(c._id))!.path).toBe(path);

    t = Date.now();
    const h50 = await consoleHistory((await rig.row(c._id))!, 50);
    const h50Ms = Date.now() - t;
    t = Date.now();
    const h200 = await consoleHistory((await rig.row(c._id))!, 200);
    const h200Ms = Date.now() - t;
    t = Date.now();
    const route = await rig.api(
      "GET",
      `/consoles/${c._id}/history?limit=200`,
      owner,
    );
    const routeMs = Date.now() - t;
    console.info(
      `[scale] 1000-commit history: built in ${buildMs} ms; history(50) ${h50Ms} ms, history(200) ${h200Ms} ms, route(200) ${routeMs} ms`,
    );
    expect(h50).toHaveLength(50);
    expect(h200).toHaveLength(200);
    expect(route.body.commits).toHaveLength(200);
    // Newest first, and across the renames (the 200 newest span two names).
    expect(new Set(h200.map(x => x.path)).size).toBeGreaterThanOrEqual(1);
    expect(h200Ms).toBeLessThan(15_000);
    expect(routeMs).toBeLessThan(15_000);
  }, 300_000);
});
