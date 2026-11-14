/**
 * The console rename/move service, the trash, and what the index sync
 * makes of a rename done on a laptop — real git, real Mongo.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/** Every realtime event, with how many folders existed when it was sent. */
const announced = vi.hoisted(
  () => [] as Array<{ type: string; folders: Promise<number> }>,
);
vi.mock("../services/realtime.service", async original => {
  const actual =
    await original<typeof import("../services/realtime.service")>();
  const { ConsoleFolder: Folders } =
    await import("../database/workspace-schema");
  return {
    ...actual,
    publishRealtimeEvent: (workspaceId: string, event: { type: string }) => {
      announced.push({ type: event.type, folders: Folders.countDocuments({}) });
      return actual.publishRealtimeEvent(workspaceId, event as never);
    },
  };
});

import { ConsoleFolder, SavedConsole } from "../database/workspace-schema";
import {
  ConsoleConflictError,
  ConsoleNameError,
  ConsolePathTakenError,
  ConsoleScopeError,
} from "../utils/console-manager";
import { log, repoDirFor } from "./repository.service";
import {
  consoleCommitChanges,
  consoleFileVersions,
  consoleHistory,
  uniquePath,
} from "./workspace-consoles.service";
import { NotEntityPathError } from "./entity-git-history";
import {
  ALICE,
  BOB,
  MAIN,
  WS,
  consoleFiles,
  fileAt,
  found,
  listedIds,
  manager,
  push,
  resetRig,
  row,
  save,
  startRig,
  stopRig,
  sync,
} from "./console-test-rig";

beforeAll(startRig);
afterAll(stopRig);
beforeEach(resetRig);

const as = (userId: string, isAdmin = false) => ({ userId, isAdmin });
const folder = (
  name: string,
  by = ALICE,
  access: "private" | "workspace" = "workspace",
  parentId?: string,
) => manager.createFolder(name, WS, by, parentId, false, access);

describe("rename and move", () => {
  it("moves the file as it is on main in one commit: same id, the unsaved draft stays a draft", async () => {
    const saved = await save("a", "SELECT 1");
    const id = saved._id.toString();
    // An edit that was never saved (an autosave, an agent's change).
    await SavedConsole.updateOne({ _id: id }, { $set: { code: "DRAFT" } });
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;

    const moved = await manager.relocateConsole(
      id,
      WS,
      { name: "b" },
      as(ALICE),
    );

    expect(moved?.row._id.toString()).toBe(id);
    expect(await consoleFiles()).toEqual(["consoles/b.sql"]);
    expect(await fileAt("consoles/b.sql")).toBe("SELECT 1\n");
    expect((await row(id))?.code).toBe("DRAFT");
    const commits = await log(repoDirFor(WS), MAIN, 50);
    expect(commits.length).toBe(before + 1);
    expect(commits[0].oid).toBe(moved?.commit);
  });

  it("renames and moves in one commit, and a draft is renamed in the index only", async () => {
    const team = await folder("Team");
    const id = (await save("a"))._id.toString();
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    await manager.moveConsole(id, WS, team._id.toString(), undefined, ALICE, {
      name: "b",
    });
    expect(await consoleFiles()).toEqual(["consoles/Team/b.sql"]);
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before + 1);

    const draft = await SavedConsole.create({
      workspaceId: WS,
      name: "scratch",
      code: "x",
      language: "sql",
      createdBy: ALICE,
      isSaved: false,
      executionCount: 0,
    });
    const renamed = await manager.relocateConsole(
      draft._id.toString(),
      WS,
      { name: "notes" },
      as(ALICE),
    );
    expect(renamed?.row.name).toBe("notes");
    expect(renamed?.commit).toBeUndefined();
    expect(await consoleFiles()).toEqual(["consoles/Team/b.sql"]);
  });

  it("refuses a name another console has, in any letter case or Unicode form", async () => {
    const a = (await save("a"))._id.toString();
    await save("Report");
    await save("Café");
    const rename = (name: string) =>
      manager.relocateConsole(a, WS, { name }, as(ALICE));
    await expect(rename("Report")).rejects.toBeInstanceOf(
      ConsolePathTakenError,
    );
    await expect(rename("report")).rejects.toThrow(/already exists/);
    await expect(rename("Café")).rejects.toBeInstanceOf(ConsoleConflictError);
    // Its own name in another case is its own file: a rename, not a clash.
    expect((await rename("A"))?.row.name).toBe("A");
    expect(await consoleFiles()).toContain("consoles/A.sql");
  });

  it("refuses a name a laptop pushed and the index has not seen", async () => {
    const a = (await save("a"))._id.toString();
    await push({ "consoles/pushed.sql": "SELECT 'laptop'\n" });
    await expect(
      manager.relocateConsole(a, WS, { name: "pushed" }, as(ALICE)),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await fileAt("consoles/pushed.sql")).toContain("laptop");
  });

  it("follows the file when a push moved it before the index knew", async () => {
    const id = (await save("a", "SELECT 7"))._id.toString();
    await push({ "consoles/elsewhere.sql": "SELECT 7\n" }, ["consoles/a.sql"]);
    const moved = await manager.relocateConsole(
      id,
      WS,
      { name: "b" },
      as(ALICE),
    );
    expect(moved?.row._id.toString()).toBe(id);
    expect(await consoleFiles()).toEqual(["consoles/b.sql"]);
  });

  it("history follows the console across renames, and only its own file", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    await save("a", "SELECT 2");
    await manager.relocateConsole(id, WS, { name: "b" }, as(ALICE));
    // A new console takes the old name: not part of the first one's past.
    const other = await save("a", "SELECT 'other'");

    const renamed = await found(id);
    const history = await consoleHistory(renamed);
    expect(history.map(c => c.path)).toEqual([
      "consoles/b.sql",
      "consoles/a.sql",
      "consoles/a.sql",
    ]);
    expect(history[0].previousPath).toBe("consoles/a.sql");

    // The first save, read under the name the file had then.
    const first = history[2].oid;
    expect((await consoleFileVersions(renamed, first)).after).toBe(
      "SELECT 1\n",
    );
    expect(
      (await consoleFileVersions(renamed, first, "consoles/b.sql")).after,
    ).toBe("SELECT 1\n");
    expect(
      (await consoleCommitChanges(renamed, history[0].oid)).files.map(
        f => f.path,
      ),
    ).toEqual(["consoles/b.sql"]);

    // The newcomer's commit is not the renamed console's, by any path.
    const [theirs] = await consoleHistory(await found(other._id));
    await expect(
      consoleFileVersions(renamed, theirs.oid, "consoles/a.sql"),
    ).rejects.toBeInstanceOf(NotEntityPathError);
    expect((await consoleCommitChanges(renamed, theirs.oid)).files).toEqual([]);
    expect((await consoleHistory(await found(other._id))).length).toBe(1);
  });
});

describe("names", () => {
  it("stores a readable stand-in for characters a file name cannot carry", async () => {
    const id = (await save("a"))._id.toString();
    const rename = async (name: string) =>
      (await manager.relocateConsole(id, WS, { name }, as(ALICE)))?.row.name;
    expect(await rename("Q1: revenue")).toBe("Q1 - revenue");
    expect(await consoleFiles()).toEqual(["consoles/Q1 - revenue.sql"]);
    // Typed again, the name it already has is no change (and no commit).
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    expect(await rename("Q1: revenue")).toBe("Q1 - revenue");
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before);
    expect(await rename('a/b\\c|d*e?f"g<h>')).toBe("a-b-c-d-ef'g(h)");
    expect(await rename("Café   au  lait")).toBe("Café au lait");
    // Every naming path: a save, a copy, a folder.
    expect((await save("New: one")).name).toBe("New - one");
    expect((await folder("Plans: Q1")).name).toBe("Plans - Q1");
  });

  it("refuses what is still no name, with the reason, and changes nothing", async () => {
    const id = (await save("a"))._id.toString();
    for (const bad of [
      "..",
      ".hidden",
      "trailing.",
      "con",
      "NUL.txt",
      "???",
      "  ",
      "x".repeat(121),
      "line\nbreak",
    ]) {
      await expect(
        manager.relocateConsole(id, WS, { name: bad }, as(ALICE)),
        bad,
      ).rejects.toBeInstanceOf(ConsoleNameError);
      await expect(folder(bad), bad).rejects.toBeInstanceOf(ConsoleNameError);
    }
    expect(await consoleFiles()).toEqual(["consoles/a.sql"]);
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
    expect(
      (
        await manager.relocateConsole(
          id,
          WS,
          { name: "x".repeat(120) },
          as(ALICE),
        )
      )?.row.name,
    ).toHaveLength(120);
  });

  it("refuses a folder that is another's twin, where it is created, renamed or moved to", async () => {
    const team = await folder("Team");
    await expect(folder("team")).rejects.toBeInstanceOf(ConsoleConflictError);
    const other = await folder("Other");
    await expect(
      manager.renameFolder(other._id.toString(), "TEAM", WS, ALICE),
    ).rejects.toThrow(/already exists/);
    const nested = await folder(
      "team",
      ALICE,
      "workspace",
      other._id.toString(),
    );
    await expect(
      manager.moveFolder(nested._id.toString(), WS, null, undefined, ALICE),
    ).rejects.toBeInstanceOf(ConsoleConflictError);
    // A private folder at the root only collides with its owner's own.
    expect((await folder("Team", BOB, "private")).name).toBe("Team");
    expect(team.name).toBe("Team");
  });

  it("a name at the length limit can be copied again and again", async () => {
    const long = "x".repeat(120);
    const id = (await save(long))._id.toString();
    const copy = async (of: string) => {
      const made = await manager.duplicateConsole(of, WS, ALICE);
      if (!made) throw new Error("no copy");
      return made;
    };
    const first = await copy(id);
    const second = await copy(id);
    const third = await copy(first._id.toString());
    const names = [first.name, second.name, third.name];
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(120);
    expect(first.name.endsWith(" copy")).toBe(true);
    expect(second.name.endsWith(" (2)")).toBe(true);
    expect(new Set((await consoleFiles()).map(p => p.toLowerCase())).size).toBe(
      4,
    );

    // The suffix search itself: every candidate differs, so it ends.
    const taken = new Set([
      `consoles/${long}.sql`,
      `consoles/${"x".repeat(116)} (2).sql`,
    ]);
    expect(uniquePath(`consoles/${long}.sql`, taken, null)).toBe(
      `consoles/${"x".repeat(116)} (3).sql`,
    );
  });
});

describe("who may change who sees it", () => {
  it("someone who can edit a console renames it, and cannot move it to where others see it differently", async () => {
    const shared = await folder("Shared", ALICE, "workspace");
    const mine = await save("mine", "SELECT 1", { access: "private" });
    const id = mine._id.toString();
    await SavedConsole.updateOne(
      { _id: id },
      { $set: { sharedWith: [{ userId: BOB, role: "editor" }] } },
    );

    expect(
      (await manager.relocateConsole(id, WS, { name: "ours" }, as(BOB)))?.row
        .name,
    ).toBe("ours");
    // Into a workspace folder, or made workspace-visible: the owner's call.
    await expect(
      manager.relocateConsole(
        id,
        WS,
        { folderId: shared._id.toString() },
        as(BOB),
      ),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    await expect(
      manager.relocateConsole(id, WS, { access: "workspace" }, as(BOB)),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    expect(await consoleFiles()).toEqual(["users/alice/consoles/ours.sql"]);

    // A workspace admin may; so may the owner.
    expect(
      await manager.relocateConsole(
        id,
        WS,
        { folderId: shared._id.toString() },
        as(BOB, true),
      ),
    ).not.toBeNull();
    // In a workspace folder it is seen by the workspace already: the
    // editor may rename it there — the explorer sends the section it is
    // shown in — and its own access is left as its owner set it.
    const within = await manager.relocateConsole(
      id,
      WS,
      { name: "theirs", folderId: shared._id.toString(), access: "workspace" },
      as(BOB),
    );
    expect(within?.row.access).toBe("private");
    expect(within?.row.path).toBe("users/alice/consoles/Shared/theirs.sql");
    await manager.relocateConsole(id, WS, { name: "ours" }, as(BOB));
    expect(
      await manager.relocateConsole(
        id,
        WS,
        { folderId: null, access: "workspace" },
        as(ALICE),
      ),
    ).not.toBeNull();
    expect(await consoleFiles()).toEqual(["consoles/ours.sql"]);
  });

  it("a folder that holds another member's console is not moved to where others see it differently", async () => {
    const team = await folder("Team", ALICE, "workspace");
    const theirs = await save("bobs", "SELECT 1", { by: BOB });
    await manager.moveConsole(
      theirs._id.toString(),
      WS,
      team._id.toString(),
      undefined,
      BOB,
    );
    const move = (isAdmin: boolean) =>
      manager.moveFolder(
        team._id.toString(),
        WS,
        null,
        "private",
        ALICE,
        isAdmin,
      );
    await expect(move(false)).rejects.toBeInstanceOf(ConsoleScopeError);
    expect(await consoleFiles()).toEqual(["consoles/Team/bobs.sql"]);
    expect(await move(true)).toBe(true);
  });
});

describe("trash", () => {
  it("a console deleted in Mako is never brought back by the index sync; a file at its old path is a new console", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    expect(await manager.softDeleteConsole(id, WS, ALICE)).toBe(true);
    expect((await row(id))?.deletedVia).toBe("app");

    await push({ "consoles/a.sql": "SELECT 'new'\n" });
    expect(await listedIds()).not.toContain(id);
    await sync();
    await sync();

    expect((await row(id))?.is_deleted).toBe(true);
    const live = await SavedConsole.find({
      path: "consoles/a.sql",
      is_deleted: { $ne: true },
    });
    expect(live.map(r => r._id.toString())).toEqual(await listedIds());
    expect(live).toHaveLength(1);
    expect(live[0]._id.toString()).not.toBe(id);
    // Neither console's history is the other's: the trashed one keeps the
    // path it had, and that path is the newcomer's now.
    const [theirs] = await consoleHistory(live[0]);
    expect(await consoleHistory(live[0])).toHaveLength(1);
    const mine = await consoleHistory(await found(id));
    expect(mine.map(c => c.subject)).toEqual([
      "delete: consoles/a.sql",
      "create: a",
    ]);
    expect(mine.map(c => c.oid)).not.toContain(theirs.oid);
  });

  it("a console a push deleted comes back, same id, when its file is pushed back", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    await push({}, ["consoles/a.sql"]);
    await sync();
    expect((await row(id))?.deletedVia).toBe("git");
    await push({ "consoles/a.sql": "SELECT 1\n" });
    await sync();
    expect((await row(id))?.is_deleted).toBe(false);
    expect(await listedIds()).toEqual([id]);
  });

  it("restores in place what was last committed, with its history; as “name (2)” when the name was taken", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    await SavedConsole.updateOne({ _id: id }, { $set: { code: "DRAFT" } });
    await manager.softDeleteConsole(id, WS, ALICE);
    // Not a live console: there is nothing to restore twice, or rename.
    expect(
      await manager.relocateConsole(id, WS, { name: "z" }, as(ALICE)),
    ).toBeNull();

    const back = await manager.restoreConsole(id, WS, ALICE);
    expect(back?.name).toBe("a");
    expect(await fileAt("consoles/a.sql")).toBe("SELECT 1\n");
    expect(await manager.restoreConsole(id, WS, ALICE)).toBeNull();
    expect((await consoleHistory(await found(id))).map(c => c.subject)).toEqual(
      ["restore: a", "delete: consoles/a.sql", "create: a"],
    );

    await manager.softDeleteConsole(id, WS, ALICE);
    await save("A", "SELECT 'taken'");
    const again = await manager.restoreConsole(id, WS, ALICE);
    expect(again?.name).toBe("a (2)");
    expect(await fileAt("consoles/A.sql")).toContain("taken");
    expect(await fileAt("consoles/a (2).sql")).toBe("SELECT 1\n");
  });

  it("deleting a folder moves its consoles to the trash and answers with what an Undo puts back", async () => {
    const team = await folder("Team");
    const sub = await folder("Sub", ALICE, "workspace", team._id.toString());
    const one = await save("one");
    const two = await save("two");
    await manager.moveConsole(
      one._id.toString(),
      WS,
      team._id.toString(),
      undefined,
      ALICE,
    );
    await manager.moveConsole(
      two._id.toString(),
      WS,
      sub._id.toString(),
      undefined,
      ALICE,
    );

    announced.length = 0;
    const trashed = await manager.deleteFolder(team._id.toString(), WS, ALICE);

    // Announced once the folders are gone: a window that refetches the
    // tree on the event must not list the deleted folder, empty.
    const deletions = announced.filter(e => e.type === "console.deleted");
    expect(deletions).toHaveLength(2);
    expect(await Promise.all(deletions.map(e => e.folders))).toEqual([0, 0]);

    expect(await consoleFiles()).toEqual([]);
    expect(await ConsoleFolder.countDocuments({})).toBe(0);
    expect(trashed?.folders.map(f => [f.name, f.parentId])).toEqual([
      ["Team", null],
      ["Sub", team._id.toString()],
    ]);
    expect(trashed?.consoles.map(c => [c.name, c.folderId]).sort()).toEqual([
      ["one", team._id.toString()],
      ["two", sub._id.toString()],
    ]);
    // Rows, ids and history are kept: trash, not erasure.
    for (const c of [one, two]) {
      const kept = await row(c._id);
      expect(kept?.is_deleted).toBe(true);
      expect(kept?.deletedVia).toBe("app");
    }
    await sync();
    expect(await listedIds()).toEqual([]);

    // Undo: the folder again, the console back in it; a folder that is
    // gone means the root.
    const again = await folder("Team");
    const back = await manager.restoreConsole(one._id.toString(), WS, ALICE, {
      folderId: again._id.toString(),
    });
    expect(back?.path).toBe("consoles/Team/one.sql");
    const atRoot = await manager.restoreConsole(two._id.toString(), WS, ALICE, {
      folderId: sub._id.toString(),
    });
    expect(atRoot?.path).toBe("consoles/two.sql");
    expect(atRoot?.folderId ?? null).toBeNull();
  });

  it("a folder holding another member's console is deleted only by a workspace admin", async () => {
    const team = await folder("Team");
    const theirs = await save("bobs", "SELECT 1", { by: BOB });
    await manager.moveConsole(
      theirs._id.toString(),
      WS,
      team._id.toString(),
      undefined,
      BOB,
    );
    await expect(
      manager.deleteFolder(team._id.toString(), WS, ALICE),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    expect(await consoleFiles()).toEqual(["consoles/Team/bobs.sql"]);
    expect(await ConsoleFolder.countDocuments({})).toBe(1);
    expect(
      (await manager.deleteFolder(team._id.toString(), WS, ALICE, true))
        ?.consoles,
    ).toHaveLength(1);
    expect((await row(theirs._id))?.is_deleted).toBe(true);
  });
});

describe("a rename done on a laptop", () => {
  it("keeps the id when the file was moved and edited in one commit", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `SELECT ${i}`).join(
      ";\n",
    );
    const id = (await save("a", body))._id.toString();
    await push({ "consoles/b.sql": `${body};\nSELECT 'edited'\n` }, [
      "consoles/a.sql",
    ]);
    const stats = await sync();
    expect(stats?.renamed).toBe(1);
    const now = await row(id);
    expect(now?.path).toBe("consoles/b.sql");
    expect(now?.name).toBe("b");
    expect(now?.code).toContain("edited");
    expect(await listedIds()).toEqual([id]);
  });

  it("follows a chain of moves made in one push", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `SELECT ${i}`).join(
      ";\n",
    );
    const id = (await save("a", body))._id.toString();
    await push({ "consoles/b.sql": `${body};\nSELECT 'one'\n` }, [
      "consoles/a.sql",
    ]);
    await push(
      { "consoles/c.sql": `${body};\nSELECT 'one';\nSELECT 'two'\n` },
      ["consoles/b.sql"],
    );
    await sync();
    expect((await row(id))?.path).toBe("consoles/c.sql");
    expect(await listedIds()).toEqual([id]);
  });

  it("never hands a console to a file in another member's tree, nor a deleted one to a lookalike", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `SELECT ${i}`).join(
      ";\n",
    );
    const id = (await save("a", body))._id.toString();
    await push({ "users/bob/consoles/a.sql": `${body}\n` }, ["consoles/a.sql"]);
    await sync();
    expect((await row(id))?.is_deleted).toBe(true);
    const bobs = await SavedConsole.findOne({
      path: "users/bob/consoles/a.sql",
    });
    expect(bobs?._id.toString()).not.toBe(id);
    expect(bobs?.owner_id).toBe(BOB);

    // The same content pushed later, elsewhere: the deleted row stays so.
    await push({ "consoles/later.sql": `${body}\n` });
    await sync();
    expect((await row(id))?.is_deleted).toBe(true);
  });

  it("a new file at a renamed console's first path gets an id of its own", async () => {
    await push({ "consoles/born.sql": "SELECT 'git'\n" });
    await sync();
    const [born] = await listedIds();
    await manager.relocateConsole(born, WS, { name: "grown" }, as(ALICE, true));
    await push({ "consoles/born.sql": "SELECT 'second'\n" });
    // Listed before any sync, and indexed after it, under one new id.
    const listed = (await listedIds()).filter(i => i !== born);
    expect(listed).toHaveLength(1);
    await sync();
    expect((await listedIds()).sort()).toEqual([born, listed[0]].sort());
    expect((await row(born))?.path).toBe("consoles/grown.sql");
    expect((await row(listed[0]))?.path).toBe("consoles/born.sql");
  });
});
