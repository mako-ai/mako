/**
 * A console's rename and delete, interleaved on purpose.
 *
 * Each test holds the first operation right after it has read where the
 * file is (or right after its commit), lets the second run to completion,
 * then lets the first finish. The assertions are about OUTCOMES, in every
 * order: when DELETE says it succeeded the console is in the trash, its
 * file is gone from main at whatever path it had, and it stays deleted
 * through two index syncs; a rename never succeeds on a console a delete
 * took; nothing is overwritten.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConsoleConflictError,
  ConsolePathTakenError,
} from "../utils/console-manager";
import {
  ALICE,
  WS,
  consoleFiles,
  fileAt,
  holdAt,
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

/** What "deleted" has to mean, however the race went. */
async function expectDeletedForGood(id: string): Promise<void> {
  expect(await consoleFiles()).toEqual([]);
  for (let pass = 0; pass < 3; pass++) {
    const now = await row(id);
    expect(now?.is_deleted).toBe(true);
    expect(now?.deletedVia).toBe("app");
    expect(await listedIds()).not.toContain(id);
    await sync();
  }
  expect(await consoleFiles()).toEqual([]);
}

const rename = (id: string, name: string) =>
  manager.relocateConsole(id, WS, { name }, { userId: ALICE });
const remove = (id: string) => manager.softDeleteConsole(id, WS, ALICE);

describe("delete and rename of one console", () => {
  it("a delete held after its read, a rename completing meanwhile: the renamed file is removed too", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterRead");
    const deleting = remove(id);
    await hold.reached;

    expect((await rename(id, "b"))?.row.name).toBe("b");
    expect(await consoleFiles()).toEqual(["consoles/b.sql"]);

    hold.release();
    expect(await deleting).toBe(true);
    await expectDeletedForGood(id);
  });

  it("a rename held after its read, a delete completing meanwhile: the rename answers not found", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterRead");
    const renaming = rename(id, "b");
    await hold.reached;

    expect(await remove(id)).toBe(true);

    hold.release();
    expect(await renaming).toBeNull();
    expect((await row(id))?.name).toBe("a");
    await expectDeletedForGood(id);
  });

  it("a rename held after its commit, a delete completing meanwhile: the moved file is removed, the rename answers not found", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterCommit");
    const renaming = rename(id, "b");
    await hold.reached;
    expect(await consoleFiles()).toEqual(["consoles/b.sql"]);

    expect(await remove(id)).toBe(true);

    hold.release();
    expect(await renaming).toBeNull();
    await expectDeletedForGood(id);
  });

  it("a delete held after its read, a laptop push moving the file meanwhile: the file is removed where it went", async () => {
    const saved = await save("a", "SELECT 42");
    const id = saved._id.toString();
    const hold = holdAt("afterRead");
    const deleting = remove(id);
    await hold.reached;

    await push({ "consoles/moved.sql": "SELECT 42\n" }, ["consoles/a.sql"]);

    hold.release();
    expect(await deleting).toBe(true);
    await expectDeletedForGood(id);
  });

  it("a delete that keeps losing answers a conflict and deletes nothing", async () => {
    const id = (await save("a", "SELECT 42"))._id.toString();
    // Every read is followed by a push that edits the file: the removal's
    // compare-and-swap never holds.
    let n = 0;
    const { consoleCommitHooks } = await import("./workspace-consoles.service");
    consoleCommitHooks.afterRead = async () => {
      await push({ "consoles/a.sql": `SELECT ${++n}\n` });
    };
    await expect(remove(id)).rejects.toBeInstanceOf(ConsoleConflictError);
    consoleCommitHooks.afterRead = undefined;
    expect(n).toBe(3);
    expect((await row(id))?.is_deleted).not.toBe(true);
    expect(await consoleFiles()).toEqual(["consoles/a.sql"]);
  });
});

describe("a delete against the index sync and a folder delete", () => {
  it("a sync that read the row before the delete does not take it out of the trash", async () => {
    const id = (await save("a", "SELECT 1"))._id.toString();
    // A push edits the file, so the sync has something to write to the row.
    await push({ "consoles/a.sql": "SELECT 2\n" });
    const hold = holdAt("afterSyncRead");
    const syncing = sync();
    await hold.reached;

    // The console is deleted, and a new file is pushed at its old path,
    // while the sync still holds the row as it read it: live, at that path.
    expect(await remove(id)).toBe(true);
    await push({ "consoles/a.sql": "SELECT 'someone else'\n" });

    hold.release();
    await syncing;
    for (let pass = 0; pass < 3; pass++) {
      const now = await row(id);
      expect(now?.is_deleted).toBe(true);
      expect(now?.deletedVia).toBe("app");
      expect(await listedIds()).not.toContain(id);
      await sync();
    }
    // The file is a new console's, under its own id.
    expect(await listedIds()).toHaveLength(1);
    expect(await rename(id, "b")).toBeNull();
  });

  it("a folder delete held after its read, a console in it renamed meanwhile: the renamed file goes too", async () => {
    const team = await manager.createFolder(
      "Team",
      WS,
      ALICE,
      undefined,
      false,
      "workspace",
    );
    const id = (await save("a"))._id.toString();
    await manager.moveConsole(id, WS, team._id.toString(), undefined, ALICE);
    const hold = holdAt("afterRead");
    const deleting = manager.deleteFolder(team._id.toString(), WS, ALICE);
    await hold.reached;

    expect((await rename(id, "b"))?.row.path).toBe("consoles/Team/b.sql");

    hold.release();
    expect((await deleting)?.consoles.map(c => c.id)).toEqual([id]);
    await expectDeletedForGood(id);
  });
});

describe("two renames", () => {
  it("racing for one free name: one wins, the other is refused, nothing is overwritten", async () => {
    const a = (await save("a", "SELECT 'a'"))._id.toString();
    const b = (await save("b", "SELECT 'b'"))._id.toString();
    const hold = holdAt("afterRead");
    const first = rename(a, "report");
    await hold.reached;

    expect((await rename(b, "report"))?.row.name).toBe("report");

    hold.release();
    await expect(first).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await consoleFiles()).toEqual([
      "consoles/a.sql",
      "consoles/report.sql",
    ]);
    expect(await fileAt("consoles/report.sql")).toContain("'b'");
    expect((await row(a))?.name).toBe("a");
  });

  it("a name a laptop pushed meanwhile, not indexed yet, is not overwritten", async () => {
    const a = (await save("a", "SELECT 'a'"))._id.toString();
    const hold = holdAt("afterRead");
    const renaming = rename(a, "report");
    await hold.reached;

    await push({ "consoles/report.sql": "SELECT 'laptop'\n" });

    hold.release();
    await expect(renaming).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await fileAt("consoles/report.sql")).toContain("laptop");
    expect(await fileAt("consoles/a.sql")).toContain("'a'");
  });

  it("of the same console, one held after its read: both converge on one file under one id", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterRead");
    const first = rename(id, "first");
    await hold.reached;

    expect((await rename(id, "second"))?.row.name).toBe("second");

    hold.release();
    // The held one finds the file gone from where it read it, takes the
    // index in and renames again from where the console is now.
    expect((await first)?.row.name).toBe("first");
    expect(await consoleFiles()).toEqual(["consoles/first.sql"]);
    expect((await row(id))?.path).toBe("consoles/first.sql");
    expect(await listedIds()).toEqual([id]);
  });

  it("of the same console, one held after its commit: the later rename stands and the held one says so", async () => {
    const id = (await save("a"))._id.toString();
    const hold = holdAt("afterCommit");
    const first = rename(id, "first");
    await hold.reached;

    expect((await rename(id, "second"))?.row.name).toBe("second");

    hold.release();
    await expect(first).rejects.toBeInstanceOf(ConsoleConflictError);
    const now = await row(id);
    expect(now?.name).toBe("second");
    expect(now?.path).toBe("consoles/second.sql");
    expect(await consoleFiles()).toEqual(["consoles/second.sql"]);
  });
});
