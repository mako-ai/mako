/**
 * Consoles in git (apps.md §16): real bare repos under a temp APPS_GIT_ROOT,
 * mongodb-memory-server for the derived index, no network. Description
 * derivation runs against "unavailable" providers, which is the point of
 * the sha-gating tests — the bookkeeping must be right with or without an
 * LLM in the room.
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
  ConsoleFolder,
  EntityVersion,
  SavedConsole,
} from "../database/workspace-schema";
import {
  CONSOLES_README_PATH,
  parseConsoleFile,
  serializeConsoleFile,
} from "./console-files";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  log,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import { runGit } from "./git";
import {
  adoptWorkspaceConsoles,
  commitConsoleState,
  consoleCommitChanges,
  consoleFileVersions,
  consoleHistory,
  deriveConsoleDescription,
  derivedConsoleId,
  listConsoleDefinitionsAtMain,
  loadLiveConsoleById,
  loadLiveConsoles,
  projectSavedConsole,
  restoreConsoleTo,
  syncConsolesIndexFromRepo,
} from "./workspace-consoles.service";
import {
  ConsoleManager,
  ConsolePathTakenError,
  ConsoleScopeError,
  type ConsoleFile,
} from "../utils/console-manager";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";

// Observability for the cost-bound paths: how often rename detection runs,
// and how many syncs a stale-path heal queues. Both wrappers delegate to
// the real implementation, so every other test here is unaffected.
const spies = vi.hoisted(() => ({
  detect: vi.fn<(...args: unknown[]) => unknown>(),
  serialized: vi.fn<(key: string) => void>(),
}));
vi.mock("../rename/git-renames", async importOriginal => {
  const actual = await importOriginal<typeof import("../rename/git-renames")>();
  return {
    ...actual,
    detectRenamedPaths: (
      ...args: Parameters<typeof actual.detectRenamedPaths>
    ) => {
      spies.detect(...args);
      return actual.detectRenamedPaths(...args);
    },
  };
});
vi.mock("./serialized", async importOriginal => {
  const actual = await importOriginal<typeof import("./serialized")>();
  return {
    ...actual,
    createSerializer: () => {
      const real = actual.createSerializer();
      return <T>(key: string, fn: () => Promise<T>) => {
        spies.serialized(key);
        return real(key, fn);
      };
    },
  };
});

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-consoles-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeEach(async () => {
  await SavedConsole.deleteMany({});
  await ConsoleFolder.deleteMany({});
  await EntityVersion.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function fileAt(rel: string): Promise<string | null> {
  try {
    return (await readBlob(repoDirFor(WS), MAIN, rel)).contents;
  } catch {
    return null;
  }
}

async function treePaths(): Promise<string[]> {
  const head = await resolveCommit(repoDirFor(WS), MAIN);
  if (!head) return [];
  return (await listTree(repoDirFor(WS), head)).map(e => e.path).sort();
}

/** A push from "elsewhere": commit straight onto the bare repo's main. */
async function externalCommit(
  writes: Record<string, string>,
  deletes: string[] = [],
  message = "external edit",
) {
  return commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message, author: { name: "Laptop", email: "laptop@example.com" } },
  );
}

const manager = new ConsoleManager();

describe("blobOid", () => {
  it("matches git hash-object", async () => {
    const contents = "SELECT 1\n-- é\n";
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    const { stdout } = await runGit(
      ["-C", repoDirFor(WS), "hash-object", "--stdin"],
      { stdin: contents },
    );
    expect(blobOid(contents)).toBe(stdout.trim());
  });
});

describe("write-through", () => {
  it("saveConsole commits the file first and stamps the row", async () => {
    const saved = await manager.saveConsole(
      "Finance/Revenue by month",
      "SELECT sum(amount) FROM invoices GROUP BY 1",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { language: "sql", access: "workspace", description: "MRR walk" },
    );
    expect(saved.path).toBe("consoles/Finance/Revenue by month.sql");
    const file = await fileAt(saved.path!);
    expect(file).toContain("-- database: analytics");
    expect(file).toContain("-- description: MRR walk");
    expect(file).toContain("SELECT sum(amount)");
    expect(saved.sourceBlobSha).toBe(blobOid(file!));
    // Adoption marker was written by the first write.
    expect(await fileAt(CONSOLES_README_PATH)).not.toBeNull();
    // The description was typed, so it is authored and lives in the file.
    const row = await SavedConsole.findById(saved._id);
    expect(row?.descriptionSource ?? "authored").toBe("authored");
  });

  it("private consoles live under users/<owner>/consoles", async () => {
    const saved = await manager.saveConsole(
      "scratch",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      {
        access: "private",
        language: "sql",
      },
    );
    expect(saved.path).toBe(`users/${USER}/consoles/scratch.sql`);
  });

  it("rename, move, access change and delete move the file", async () => {
    const saved = await manager.saveConsole(
      "a",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      {
        access: "workspace",
        language: "sql",
      },
    );
    expect(await treePaths()).toContain("consoles/a.sql");

    expect(
      await manager.renameConsole(saved._id.toString(), "b", WS, USER),
    ).toBe(true);
    let paths = await treePaths();
    expect(paths).toContain("consoles/b.sql");
    expect(paths).not.toContain("consoles/a.sql");

    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
    );
    expect(
      await manager.moveConsole(
        saved._id.toString(),
        WS,
        folder._id.toString(),
        undefined,
        USER,
      ),
    ).toBe(true);
    paths = await treePaths();
    expect(paths).toContain("consoles/Team/b.sql");
    expect(paths).not.toContain("consoles/b.sql");

    expect(
      await manager.updateConsoleAccess(
        saved._id.toString(),
        WS,
        USER,
        "private",
      ),
    ).not.toBeNull();
    paths = await treePaths();
    expect(paths).toContain(`users/${USER}/consoles/Team/b.sql`);
    expect(paths).not.toContain("consoles/Team/b.sql");

    expect(
      await manager.softDeleteConsole(saved._id.toString(), WS, USER),
    ).toBe(true);
    expect(await treePaths()).not.toContain(
      `users/${USER}/consoles/Team/b.sql`,
    );
    // …and restore puts it back at its path.
    expect(await manager.restoreConsole(saved._id.toString(), WS, USER)).toBe(
      true,
    );
    expect(await treePaths()).toContain(`users/${USER}/consoles/Team/b.sql`);

    const history = await log(repoDirFor(WS), MAIN, 20);
    expect(history.map(c => c.subject)).toEqual(
      expect.arrayContaining([
        "rename: b",
        "move: b",
        "access private: b",
        "delete: users/" + USER + "/consoles/Team/b.sql",
        "restore: b",
      ]),
    );
  });

  it("a rename after a laptop move not yet synced follows the file; the draft is never projected", async () => {
    const report = await manager.saveConsole(
      "report",
      "SELECT 'saved' AS r\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "workspace", language: "sql" },
    );
    const reportPath = (await SavedConsole.findById(report._id))!.path!;
    await SavedConsole.updateOne(
      { _id: report._id },
      {
        $set: {
          code: "SELECT 'UNREVIEWED agent draft' AS r\n",
          lastDraftOrigin: "agent",
        },
      },
    );
    const content = (await fileAt(reportPath))!;
    // laptop: git mv report.sql report-laptop.sql, pushed, sync not run
    await externalCommit({ "consoles/report-laptop.sql": content }, [
      reportPath,
    ]);
    const moved = await manager.relocateConsole(
      report._id.toString(),
      WS,
      { name: "report-ui" },
      { userId: USER },
    );
    expect(moved?.row.path).toBe("consoles/report-ui.sql");
    expect(await fileAt("consoles/report-ui.sql")).toBe(content);
    expect(await fileAt("consoles/report-laptop.sql")).toBeNull();
    expect(await fileAt(reportPath)).toBeNull();
    expect(await syncConsolesIndexFromRepo(WS, USER)).toMatchObject({
      created: 0,
      deleted: 0,
      renamed: 0,
    });
    const rows = await SavedConsole.find({
      workspaceId: new Types.ObjectId(WS),
    });
    expect(rows).toHaveLength(1);
    // The sync that re-keyed the row took the file in (its standing rule
    // for a laptop push); the draft was never committed anywhere.
    expect(rows[0]?.code?.trim()).toBe("SELECT 'saved' AS r");
    // One rename commit, moving the laptop's file; no commit carries the draft.
    const history = await log(repoDirFor(WS), MAIN, 50);
    expect(history[0]?.subject).toBe("rename: report-ui");
    expect(history.filter(c => c.subject.startsWith("rename:"))).toHaveLength(
      1,
    );
  });

  it("a rename after a laptop EDIT not yet synced takes the edit in first (schedule, description, code)", async () => {
    const report = await manager.saveConsole(
      "report",
      "SELECT 1 AS v\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "workspace", language: "sql" },
    );
    const reportPath = (await SavedConsole.findById(report._id))!.path!;
    const laptop = serializeConsoleFile({
      name: "report",
      language: "sql",
      code: "SELECT 2 AS v_laptop\n",
      databaseName: "analytics",
      description: "laptop desc",
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
    });
    await externalCommit({ [reportPath]: laptop });
    const moved = await manager.relocateConsole(
      report._id.toString(),
      WS,
      { name: "report-renamed" },
      { userId: USER },
    );
    expect(moved?.row.path).toBe("consoles/report-renamed.sql");
    expect(await fileAt("consoles/report-renamed.sql")).toBe(laptop);
    const row = await SavedConsole.findById(report._id);
    expect(row?.code?.trim()).toBe("SELECT 2 AS v_laptop");
    expect(row?.description).toBe("laptop desc");
    expect(row?.schedule?.cron).toBe("0 6 * * *");
    expect(row?.sourceBlobSha).toBe(blobOid(laptop));
    expect(await syncConsolesIndexFromRepo(WS, USER)).toMatchObject({
      skipped: 1,
      updated: 0,
      created: 0,
    });
  });

  it("a rename after a laptop DELETE not yet synced is refused as not found; the console ends deleted", async () => {
    const report = await manager.saveConsole(
      "report",
      "SELECT 1\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "workspace", language: "sql" },
    );
    const reportPath = (await SavedConsole.findById(report._id))!.path!;
    await externalCommit({}, [reportPath]);
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    await expect(
      manager.relocateConsole(
        report._id.toString(),
        WS,
        { name: "renamed" },
        { userId: USER },
      ),
    ).resolves.toBeNull(); // the sync in between soft-deleted it: 404, not a rename
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before);
    expect((await SavedConsole.findById(report._id))?.is_deleted).toBe(true);
    expect(await fileAt("consoles/renamed.sql")).toBeNull();
  });

  it("a folder rename after a laptop edit not yet synced takes the edit in first, never a draft", async () => {
    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
      "workspace",
    );
    const x = await manager.saveConsole(
      "x",
      "SELECT 1 AS committed\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "workspace", language: "sql", folderId: folder._id.toString() },
    );
    await SavedConsole.updateOne(
      { _id: x._id },
      {
        $set: {
          code: "SELECT 2 AS unsaved_agent_draft\n",
          lastDraftOrigin: "agent",
        },
      },
    );
    const laptop = serializeConsoleFile({
      name: "x",
      language: "sql",
      code: "SELECT 3 AS v_laptop\n",
      databaseName: "analytics",
    });
    await externalCommit({ "consoles/Team/x.sql": laptop });
    expect(
      await manager.renameFolder(folder._id.toString(), "Team2", WS, USER),
    ).toBe(true);
    const row = await SavedConsole.findById(x._id);
    expect(row?.path).toBe("consoles/Team2/x.sql");
    expect(await fileAt("consoles/Team2/x.sql")).toBe(laptop);
    expect(await fileAt("consoles/Team/x.sql")).toBeNull();
    expect(row?.code?.trim()).toBe("SELECT 3 AS v_laptop");
    expect(row?.sourceBlobSha).toBe(blobOid(laptop));
    // The folder itself was renamed, not re-created by a sync in between.
    expect(await ConsoleFolder.countDocuments({ workspaceId: WS })).toBe(1);
    expect((await ConsoleFolder.findById(folder._id))?.name).toBe("Team2");
  });

  it("a refused folder move leaves no row re-scoped: private stays private, the other console's file is safe", async () => {
    const OTHER = new Types.ObjectId().toString();
    const wsFolder = await manager.createFolder(
      "Scratch",
      WS,
      OTHER,
      undefined,
      false,
      "workspace",
    );
    const theirs = await manager.saveConsole(
      "test",
      "SELECT 'theirs'\n",
      WS,
      OTHER,
      undefined,
      undefined,
      undefined,
      {
        access: "workspace",
        language: "sql",
        folderId: wsFolder._id.toString(),
      },
    );
    expect(theirs.path).toBe("consoles/Scratch/test.sql");
    const myFolder = await manager.createFolder(
      "Scratch",
      WS,
      USER,
      undefined,
      false,
      "private",
    );
    const mine = await manager.saveConsole(
      "test",
      "SELECT 'my secret'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql", folderId: myFolder._id.toString() },
    );
    expect(mine.path).toBe(`users/${USER}/consoles/Scratch/test.sql`);
    // "Move to…" my folder into the Workspace section: the target file is theirs.
    await expect(
      manager.moveFolder(myFolder._id.toString(), WS, null, "workspace", USER),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect((await ConsoleFolder.findById(myFolder._id))?.access).toBe(
      "private",
    );
    const row = await SavedConsole.findById(mine._id);
    expect(row?.access).toBe("private");
    expect(row?.isPrivate).toBe(true);
    expect(row?.path).toBe(`users/${USER}/consoles/Scratch/test.sql`);
    expect(await manager.canReadWithInheritance(row!, OTHER)).toBe(false);
    // My next ordinary save stays on my file; theirs is untouched.
    await manager.saveConsole(
      "test",
      "SELECT 'my secret v2'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      {
        id: mine._id.toString(),
        language: "sql",
        folderId: myFolder._id.toString(),
      },
    );
    expect(await fileAt("consoles/Scratch/test.sql")).toContain("'theirs'");
    expect(await fileAt(`users/${USER}/consoles/Scratch/test.sql`)).toContain(
      "my secret v2",
    );
    expect(
      await SavedConsole.countDocuments({
        path: "consoles/Scratch/test.sql",
        is_deleted: { $ne: true },
      }),
    ).toBe(1);
    // The same guard for a folder access change and a folder rename.
    await expect(
      manager.updateFolderAccess(
        myFolder._id.toString(),
        WS,
        USER,
        "workspace",
      ),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect((await SavedConsole.findById(mine._id))?.access).toBe("private");
    await manager.renameFolder(wsFolder._id.toString(), "Other", WS, OTHER);
    await expect(
      manager.renameFolder(wsFolder._id.toString(), "Scratch", WS, OTHER),
    ).resolves.toBe(true); // back to its own name: free again
  });

  it("the editor's Rename / Move… save goes through the relocation: files at main count, scope is the owner's", async () => {
    const OTHER = new Types.ObjectId().toString();
    const x = await manager.saveConsole(
      "x",
      "SELECT 'x'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit({ "consoles/target.sql": "SELECT 'laptop work'\n" });
    const row = (await SavedConsole.findById(x._id))!;
    await expect(
      manager.relocateForSave(
        row,
        { name: "target", folderId: undefined, access: "workspace" },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await fileAt("consoles/target.sql")).toBe("SELECT 'laptop work'\n");
    // Nothing to move: same name, same folder, same access → null.
    expect(
      await manager.relocateForSave(
        row,
        { name: "x", folderId: undefined, access: "workspace" },
        USER,
      ),
    ).toBeNull();
    // A shared editor cannot publish someone's private console through a save.
    const mine = await manager.saveConsole(
      "mine",
      "SELECT 1\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql" },
    );
    await expect(
      manager.relocateForSave(
        (await SavedConsole.findById(mine._id))!,
        { name: "mine", folderId: undefined, access: "workspace" },
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    expect((await SavedConsole.findById(mine._id))?.access).toBe("private");
    // A plain move by the owner: the file moves (main's blob), revision untouched.
    const before = (await SavedConsole.findById(x._id))!.draftRevision ?? 1;
    const moved = await manager.relocateForSave(
      row,
      { name: "x-moved", folderId: undefined, access: undefined },
      USER,
    );
    expect(moved?.row.path).toBe("consoles/x-moved.sql");
    expect(await fileAt("consoles/x-moved.sql")).toContain("'x'");
    expect(await fileAt("consoles/x.sql")).toBeNull();
    expect((await SavedConsole.findById(x._id))!.draftRevision ?? 1).toBe(
      before,
    );
  });

  it("a folder flip to workspace never publishes someone else's private console, nor merges two onto one file", async () => {
    const EDITOR = new Types.ObjectId().toString();
    const team = await manager.createFolder(
      "Team",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    const theirs = await manager.saveConsole(
      "x",
      "SELECT 'owner secret'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: theirs._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );
    const mine = await manager.saveConsole(
      "x",
      "SELECT 'editor own'\n",
      WS,
      EDITOR,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql", folderId: team._id.toString() },
    );
    expect(mine.path).toBe(`users/${EDITOR}/consoles/Team/x.sql`);
    // The editor files the owner's console into their own private folder
    // (same effective visibility: allowed)…
    expect(
      await manager.moveConsole(
        theirs._id.toString(),
        WS,
        team._id.toString(),
        undefined,
        EDITOR,
      ),
    ).toBe(true);
    expect((await SavedConsole.findById(theirs._id))?.path).toBe(
      `users/${USER}/consoles/Team/x.sql`,
    );
    // …then flips the folder to the workspace: refused — not theirs to publish.
    await expect(
      manager.moveFolder(team._id.toString(), WS, null, "workspace", EDITOR),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    const a = await SavedConsole.findById(theirs._id);
    const b = await SavedConsole.findById(mine._id);
    expect(a?.access).toBe("private");
    expect(b?.access).toBe("private");
    expect(
      await manager.canReadWithInheritance(a!, new Types.ObjectId().toString()),
    ).toBe(false);
    expect(await fileAt("consoles/Team/x.sql")).toBeNull();
    expect(await fileAt(`users/${USER}/consoles/Team/x.sql`)).toContain(
      "owner secret",
    );
    // Same owner, two "y" that would meet in the workspace tree: refused.
    // (A workspace console filed into a private folder keeps its scope and
    // its workspace path; flipping the folder would land the private one
    // on that very file.)
    const own = await manager.createFolder(
      "Mine",
      WS,
      USER,
      undefined,
      false,
      "private",
    );
    const priv = await manager.saveConsole(
      "y",
      "SELECT 'private y'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql", folderId: own._id.toString() },
    );
    const pub = await manager.saveConsole(
      "y",
      "SELECT 'public y'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    expect(
      await manager.moveConsole(
        pub._id.toString(),
        WS,
        own._id.toString(),
        undefined,
        USER,
      ),
    ).toBe(true);
    expect((await SavedConsole.findById(priv._id))?.path).toBe(
      `users/${USER}/consoles/Mine/y.sql`,
    );
    expect((await SavedConsole.findById(pub._id))?.path).toBe(
      "consoles/Mine/y.sql",
    );
    await expect(
      manager.moveFolder(own._id.toString(), WS, null, "workspace", USER),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect((await SavedConsole.findById(priv._id))?.access).toBe("private");
    expect(await fileAt("consoles/Mine/y.sql")).toContain("public y");
    expect(await fileAt(`users/${USER}/consoles/Mine/y.sql`)).toContain(
      "private y",
    );
  });

  it("a shared editor cannot move the owner's private console where the workspace sees it", async () => {
    const EDITOR = new Types.ObjectId().toString();
    const OTHER = new Types.ObjectId().toString();
    const pub = await manager.createFolder(
      "Public",
      WS,
      OTHER,
      undefined,
      false,
      "workspace",
    );
    const c = await manager.saveConsole(
      "secret",
      "SELECT 'secret'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "private", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: c._id },
      { $set: { sharedWith: [{ userId: EDITOR, role: "editor" }] } },
    );
    // "Move to…" into a workspace folder with no access sent: the folder
    // would publish it by inheritance — the owner's call, not the editor's.
    await expect(
      manager.moveConsole(
        c._id.toString(),
        WS,
        pub._id.toString(),
        undefined,
        EDITOR,
      ),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    const row = await SavedConsole.findById(c._id);
    expect(row?.folderId).toBeFalsy();
    expect(await manager.canReadWithInheritance(row!, OTHER)).toBe(false);
    // The editor may still rename it within its scope, and file it into a
    // private folder of their own (still private).
    expect(
      await manager.renameConsole(c._id.toString(), "secret-2", WS, EDITOR),
    ).toBe(true);
    const own = await manager.createFolder(
      "Mine",
      WS,
      EDITOR,
      undefined,
      false,
      "private",
    );
    expect(
      await manager.moveConsole(
        c._id.toString(),
        WS,
        own._id.toString(),
        undefined,
        EDITOR,
      ),
    ).toBe(true);
    expect(
      await manager.canReadWithInheritance(
        (await SavedConsole.findById(c._id))!,
        OTHER,
      ),
    ).toBe(false);
    // The owner may publish it.
    expect(
      await manager.moveConsole(
        c._id.toString(),
        WS,
        pub._id.toString(),
        undefined,
        USER,
      ),
    ).toBe(true);
    expect(
      await manager.canReadWithInheritance(
        (await SavedConsole.findById(c._id))!,
        OTHER,
      ),
    ).toBe(true);
  });

  it("'Move to…' with a new name is ONE commit (rename + move together)", async () => {
    const saved = await manager.saveConsole(
      "draft name",
      "SELECT 2",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const folder = await manager.createFolder(
      "Archive",
      WS,
      USER,
      undefined,
      false,
    );
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    expect(
      await manager.moveConsole(
        saved._id.toString(),
        WS,
        folder._id.toString(),
        undefined,
        USER,
        "final name",
      ),
    ).toBe(true);
    const history = await log(repoDirFor(WS), MAIN, 50);
    expect(history.length).toBe(before + 1);
    expect(history[0]?.subject).toBe("move: final name");
    const paths = await treePaths();
    expect(paths).toContain("consoles/Archive/final name.sql");
    expect(paths).not.toContain("consoles/draft name.sql");
    const row = await SavedConsole.findById(saved._id);
    expect(row?.name).toBe("final name");
    expect(row?.path).toBe("consoles/Archive/final name.sql");
  });

  it("a rename moves the file AS IT IS AT MAIN; the row's unsaved draft stays a draft", async () => {
    const saved = await manager.saveConsole(
      "x",
      "SELECT 1 AS committed\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const committed = (await fileAt("consoles/x.sql"))!;
    // An agent (or an autosave) left an unreviewed draft on the row.
    await SavedConsole.updateOne(
      { _id: saved._id },
      {
        $set: { code: "SELECT 2 AS unsaved_draft\n", lastDraftOrigin: "agent" },
      },
    );
    expect(
      await manager.renameConsole(saved._id.toString(), "y", WS, USER),
    ).toBe(true);
    expect(await fileAt("consoles/y.sql")).toBe(committed);
    expect(await fileAt("consoles/x.sql")).toBeNull();
    const row = await SavedConsole.findById(saved._id);
    expect(row?.code).toBe("SELECT 2 AS unsaved_draft\n");
    expect(row?.path).toBe("consoles/y.sql");
    expect(row?.sourceBlobSha).toBe(saved.sourceBlobSha);
    // The same holds for "Move to…" (one commit, main's blob, draft kept).
    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
    );
    await manager.moveConsole(
      saved._id.toString(),
      WS,
      folder._id.toString(),
      undefined,
      USER,
      "z",
    );
    expect(await fileAt("consoles/Team/z.sql")).toBe(committed);
    expect((await SavedConsole.findById(saved._id))?.code).toBe(
      "SELECT 2 AS unsaved_draft\n",
    );
  });

  it("a rename or move onto a taken file is refused (409), never an overwrite", async () => {
    const a = await manager.saveConsole(
      "a",
      "SELECT 'A content' AS a\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const b = await manager.saveConsole(
      "b",
      "SELECT 'B content' AS b\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const aContents = (await fileAt("consoles/a.sql"))!;
    await expect(
      manager.relocateConsole(
        b._id.toString(),
        WS,
        { name: "a" },
        { userId: USER },
      ),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    // Names are sanitized into file names: " a " is the same file as "a".
    await expect(
      manager.renameConsole(b._id.toString(), " a ", WS, USER),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
    );
    await manager.moveConsole(
      a._id.toString(),
      WS,
      folder._id.toString(),
      undefined,
      USER,
    );
    await expect(
      manager.moveConsole(
        b._id.toString(),
        WS,
        folder._id.toString(),
        undefined,
        USER,
        "a",
      ),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await fileAt("consoles/Team/a.sql")).toBe(aContents);
    expect(await fileAt("consoles/b.sql")).toContain("B content");
    expect((await SavedConsole.findById(b._id))?.path).toBe("consoles/b.sql");
    const hit = await loadLiveConsoleById(WS, a._id.toString());
    expect(hit && "live" in hit ? hit.live.parsed.code : null).toContain(
      "A content",
    );
  });

  it("two renames racing for one free name: exactly one wins, nothing is overwritten", async () => {
    const a = await manager.saveConsole(
      "a",
      "SELECT 'A' AS a\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const b = await manager.saveConsole(
      "b",
      "SELECT 'B' AS b\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const results = await Promise.allSettled([
      manager.relocateConsole(
        a._id.toString(),
        WS,
        { name: "c" },
        { userId: USER },
      ),
      manager.relocateConsole(
        b._id.toString(),
        WS,
        { name: "c" },
        { userId: USER },
      ),
    ]);
    const won = results.filter(r => r.status === "fulfilled");
    const lost = results.filter(r => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConsolePathTakenError,
    );
    const rows = await SavedConsole.find({
      workspaceId: new Types.ObjectId(WS),
    });
    const paths = rows.map(r => r.path).sort();
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain("consoles/c.sql");
    const winner = rows.find(r => r.path === "consoles/c.sql")!;
    const loser = rows.find(r => r.path !== "consoles/c.sql")!;
    expect(await fileAt("consoles/c.sql")).toContain(
      winner.name === "c" ? "SELECT" : "SELECT",
    );
    expect(await fileAt(loser.path!)).toContain(
      loser.name === "a" ? "'A'" : "'B'",
    );
    expect(await fileAt("consoles/c.sql")).toContain(
      winner._id.equals(a._id) ? "'A'" : "'B'",
    );
  });

  it("a target that a laptop pushed (no row yet) is never overwritten by a rename", async () => {
    const a = await manager.saveConsole(
      "a",
      "SELECT 'A' AS a\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit({ "consoles/c.sql": "SELECT 'laptop' AS c\n" });
    await expect(
      manager.relocateConsole(
        a._id.toString(),
        WS,
        { name: "c" },
        { userId: USER },
      ),
    ).rejects.toBeInstanceOf(ConsolePathTakenError);
    expect(await fileAt("consoles/c.sql")).toBe("SELECT 'laptop' AS c\n");
    expect(await fileAt("consoles/a.sql")).toContain("'A'");
  });

  it("a folder rename/move/access change moves each file AS IT IS AT MAIN; drafts stay drafts", async () => {
    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
      "workspace",
    );
    const x = await manager.saveConsole(
      "x",
      "SELECT 1 AS committed\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql", folderId: folder._id.toString() },
    );
    const committed = (await fileAt("consoles/Team/x.sql"))!;
    await SavedConsole.updateOne(
      { _id: x._id },
      {
        $set: {
          code: "SELECT 2 AS unsaved_agent_draft\n",
          lastDraftOrigin: "agent",
        },
      },
    );
    expect(
      await manager.renameFolder(folder._id.toString(), "Team2", WS, USER),
    ).toBe(true);
    let row = await SavedConsole.findById(x._id);
    expect(row?.path).toBe("consoles/Team2/x.sql");
    expect(await fileAt("consoles/Team2/x.sql")).toBe(committed);
    expect(row?.code).toBe("SELECT 2 AS unsaved_agent_draft\n");
    const parent = await manager.createFolder(
      "Parent",
      WS,
      USER,
      undefined,
      false,
      "workspace",
    );
    expect(
      await manager.moveFolder(
        folder._id.toString(),
        WS,
        parent._id.toString(),
        undefined,
        USER,
      ),
    ).toBe(true);
    row = await SavedConsole.findById(x._id);
    expect(row?.path).toBe("consoles/Parent/Team2/x.sql");
    expect(await fileAt("consoles/Parent/Team2/x.sql")).toBe(committed);
    expect(row?.code).toBe("SELECT 2 AS unsaved_agent_draft\n");
  });

  it("a shared editor may move a console but not flip its scope; the owner may", async () => {
    const OTHER = new Types.ObjectId().toString();
    const mine = await manager.saveConsole(
      "mine",
      "SELECT 1\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const folder = await manager.createFolder(
      "Team",
      WS,
      USER,
      undefined,
      false,
      "workspace",
    );
    await expect(
      manager.moveConsole(
        mine._id.toString(),
        WS,
        folder._id.toString(),
        "private",
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ConsoleScopeError);
    expect((await SavedConsole.findById(mine._id))?.path).toBe(
      "consoles/mine.sql",
    );
    expect(
      await manager.moveConsole(
        mine._id.toString(),
        WS,
        folder._id.toString(),
        undefined,
        OTHER,
      ),
    ).toBe(true);
    expect((await SavedConsole.findById(mine._id))?.path).toBe(
      "consoles/Team/mine.sql",
    );
    expect(
      await manager.moveConsole(mine._id.toString(), WS, null, "private", USER),
    ).toBe(true);
    expect((await SavedConsole.findById(mine._id))?.path).toBe(
      `users/${USER}/consoles/mine.sql`,
    );
  });

  it("renaming a folder moves every console under it in one commit", async () => {
    // Workspace folders: a workspace console's "Old/x" is the workspace
    // "Old" (folder chains are found in the console's scope).
    const folder = await manager.createFolder(
      "Old",
      WS,
      USER,
      undefined,
      false,
      "workspace",
    );
    const sub = await manager.createFolder(
      "Sub",
      WS,
      USER,
      folder._id.toString(),
      false,
    );
    await manager.saveConsole(
      "Old/x",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await manager.saveConsole(
      "Old/Sub/y",
      "SELECT 2",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    expect(
      await manager.renameFolder(folder._id.toString(), "New", WS, USER),
    ).toBe(true);
    const paths = await treePaths();
    expect(paths).toEqual(
      expect.arrayContaining(["consoles/New/x.sql", "consoles/New/Sub/y.sql"]),
    );
    expect(paths.some(p => p.startsWith("consoles/Old/"))).toBe(false);
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before + 1);
    const rows = await SavedConsole.find({ workspaceId: WS }).sort({ name: 1 });
    expect(rows.map(r => r.path)).toEqual([
      "consoles/New/x.sql",
      "consoles/New/Sub/y.sql",
    ]);
    expect(sub).toBeTruthy();
  });

  it("a no-op save leaves no commit", async () => {
    const saved = await manager.saveConsole(
      "n",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const before = await resolveCommit(repoDirFor(WS), MAIN);
    const again = await commitConsoleState({
      row: saved,
      previousPath: saved.path,
      actorUserId: USER,
      message: "save: n",
    });
    expect(again.unchanged).toBe(true);
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(before);
  });
});

describe("sync hardening", () => {
  it("one file that fails to reconcile does not skip the files after it or the deletion pass", async () => {
    const a = await manager.saveConsole(
      "Finance/aaa",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const b = await manager.saveConsole(
      "Finance/bbb",
      "SELECT 2",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const doomed = await manager.saveConsole(
      "Finance/ccc",
      "SELECT 3",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const edit = (n: number) =>
      serializeConsoleFile({
        name: "x",
        language: "sql",
        code: `SELECT ${n} -- laptop`,
      });
    await externalCommit(
      {
        "consoles/Finance/aaa.sql": edit(10),
        "consoles/Finance/bbb.sql": edit(20),
      },
      ["consoles/Finance/ccc.sql"],
    );
    // The first row write throws (a value the schema cannot cast, a race,
    // any Mongo error); it used to escape the loop.
    const original = SavedConsole.updateOne.bind(SavedConsole);
    let failed = false;
    const spy = vi.spyOn(SavedConsole, "updateOne").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      const filter = args[0] as { _id?: unknown };
      if (!failed && String(filter?._id) === String(a._id)) {
        failed = true;
        throw new Error("simulated cast failure");
      }
      return original(...args);
    }) as typeof SavedConsole.updateOne);
    try {
      const stats = await syncConsolesIndexFromRepo(WS, USER);
      expect(stats.deleted).toBe(1);
      expect(failed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect((await SavedConsole.findById(a._id))?.code).toBe("SELECT 1");
    expect((await SavedConsole.findById(b._id))?.code).toBe(
      "SELECT 20 -- laptop",
    );
    expect((await SavedConsole.findById(doomed._id))?.is_deleted).toBe(true);
  });
});

describe("sync from repo", () => {
  it("an external edit reaches the row; unchanged blobs are skipped", async () => {
    const saved = await manager.saveConsole(
      "Finance/mrr",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    // Something unrelated changed: the console row is untouched.
    await externalCommit({ "apps/x/README.md": "hi\n" });
    let stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ skipped: 1, updated: 0, created: 0 });

    const edited = serializeConsoleFile({
      name: "mrr",
      language: "sql",
      code: "SELECT 2 -- edited on a laptop",
      databaseName: "warehouse",
      description: "Authored on the laptop",
      schedule: { cron: "0 7 * * *", timezone: "UTC" },
    });
    await externalCommit({ "consoles/Finance/mrr.sql": edited });
    stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ updated: 1 });
    const row = await SavedConsole.findById(saved._id);
    expect(row?.code).toBe("SELECT 2 -- edited on a laptop");
    expect(row?.databaseName).toBe("warehouse");
    expect(row?.description).toBe("Authored on the laptop");
    expect(row?.descriptionSource).toBe("authored");
    expect(row?.schedule?.cron).toBe("0 7 * * *");
    expect(row?.scheduledRun?.nextAt).toBeInstanceOf(Date);
    expect(row?.sourceBlobSha).toBe(blobOid(edited));
    expect(row?.version).toBe(2);
    // History is git: the sync writes no entity_versions snapshot.
    expect(await EntityVersion.countDocuments({ entityId: saved._id })).toBe(0);
  });

  it("a new file creates a row, folders and all; a removed file soft-deletes", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await externalCommit({
      "consoles/Ops/Alerts/failed jobs.sql":
        "-- connection: 6846e6a01b05af0948070583\n\nSELECT * FROM jobs WHERE failed\n",
      [`users/${USER}/consoles/mine.mongodb.js`]:
        "// collection: users\n// operation: find\n\ndb.users.find({})\n",
    });
    const stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ created: 2 });
    const shared = await SavedConsole.findOne({
      workspaceId: WS,
      name: "failed jobs",
    });
    expect(shared?.access).toBe("workspace");
    expect(shared?.connectionId?.toString()).toBe("6846e6a01b05af0948070583");
    expect(shared?.code).toBe("SELECT * FROM jobs WHERE failed");
    const chain = await ConsoleFolder.find({ workspaceId: WS }).sort({
      name: 1,
    });
    expect(chain.map(f => f.name)).toEqual(["Alerts", "Ops"]);
    const mine = await SavedConsole.findOne({ workspaceId: WS, name: "mine" });
    expect(mine?.access).toBe("private");
    expect(mine?.owner_id).toBe(USER);
    expect(mine?.language).toBe("mongodb");
    expect(mine?.mongoOptions?.collection).toBe("users");

    await externalCommit({}, ["consoles/Ops/Alerts/failed jobs.sql"]);
    const after = await syncConsolesIndexFromRepo(WS, USER);
    expect(after).toMatchObject({ deleted: 1 });
    expect((await SavedConsole.findById(shared!._id))?.is_deleted).toBe(true);
  });

  it("a rename keeps the row (id, telemetry, embedding) when the blob is unchanged", async () => {
    const saved = await manager.saveConsole(
      "old name",
      "SELECT 42",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: saved._id },
      {
        $set: {
          executionCount: 7,
          descriptionEmbedding: [0.1, 0.2],
          descriptionSourceSha: saved.sourceBlobSha,
        },
      },
    );
    const contents = (await fileAt("consoles/old name.sql"))!;
    await externalCommit({ "consoles/Archive/new name.sql": contents }, [
      "consoles/old name.sql",
    ]);
    const stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ renamed: 1, created: 0, deleted: 0 });
    const row = await SavedConsole.findById(saved._id).select(
      "+descriptionEmbedding",
    );
    expect(row?.path).toBe("consoles/Archive/new name.sql");
    expect(row?.name).toBe("new name");
    expect(row?.executionCount).toBe(7);
    expect(row?.descriptionEmbedding).toEqual([0.1, 0.2]);
    // Same content → the derivation stays current: no re-embed needed.
    expect(row?.descriptionSourceSha).toBe(row?.sourceBlobSha);
    expect(await SavedConsole.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("a rename PLUS an edit in one push keeps the row (git -M), so /c/<id> survives", async () => {
    const saved = await manager.saveConsole(
      "weekly report",
      "SELECT country, count(*) AS n\nFROM leads\nGROUP BY 1\nORDER BY 2 DESC\n-- weekly\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { executionCount: 3 } },
    );
    const contents = (await fileAt("consoles/weekly report.sql"))!;
    // `git mv` + a tweak, pushed together: the blob changes, the path too.
    await externalCommit(
      {
        "consoles/Reports/weekly leads.sql": contents.replace(
          "-- weekly",
          "-- weekly, by country",
        ),
      },
      ["consoles/weekly report.sql"],
      "laptop: move and edit",
    );
    const stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ renamed: 1, created: 0, deleted: 0 });
    const row = await SavedConsole.findById(saved._id);
    expect(row?.path).toBe("consoles/Reports/weekly leads.sql");
    expect(row?.name).toBe("weekly leads");
    expect(row?.code).toContain("-- weekly, by country");
    expect(row?.executionCount).toBe(3);
    expect(row?.is_deleted).not.toBe(true);
    expect(await SavedConsole.countDocuments({ workspaceId: WS })).toBe(1);
    // The id still resolves to the live file at its new path.
    const hit = await loadLiveConsoleById(WS, saved._id.toString());
    expect(hit && "live" in hit ? hit.live.path : null).toBe(
      "consoles/Reports/weekly leads.sql",
    );
  });

  it("a long-deleted console is never resurrected onto another user's later, merely similar file", async () => {
    const U2 = new Types.ObjectId().toString();
    const rev = await manager.saveConsole(
      "revenue",
      "SELECT date_trunc('month', created_at) AS month, sum(amount) AS revenue\nFROM orders\nWHERE status = 'paid'\nGROUP BY 1\nORDER BY 1\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: rev._id },
      { $set: { sharedWith: [{ userId: "collab", role: "editor" }] } },
    );
    await externalCommit({}, ["consoles/revenue.sql"]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect((await SavedConsole.findById(rev._id))?.is_deleted).toBe(true);
    await externalCommit({ "consoles/other1.sql": "SELECT 1\n" });
    await syncConsolesIndexFromRepo(WS, USER);
    const privatePath = `users/${U2}/consoles/refunds.sql`;
    await externalCommit({
      [privatePath]:
        "-- database: analytics\nSELECT date_trunc('month', created_at) AS month, sum(amount) AS refunds\nFROM orders\nWHERE status = 'refunded'\nGROUP BY 1\nORDER BY 1\n",
    });
    const stats = await syncConsolesIndexFromRepo(WS, U2);
    expect(stats).toMatchObject({ renamed: 0, created: 1 });
    const old = await SavedConsole.findById(rev._id);
    expect(old?.is_deleted).toBe(true);
    expect(old?.path).toBe("consoles/revenue.sql");
    const fresh = await SavedConsole.findOne({
      workspaceId: WS,
      path: privatePath,
    });
    expect(fresh?._id.toString()).not.toBe(rev._id.toString());
    expect(fresh?.owner_id).toBe(U2);
    expect(fresh?.sharedWith ?? []).toEqual([]);
  });

  it("an identical blob never resurrects a soft-deleted row; only its own path restores it", async () => {
    const U2 = new Types.ObjectId().toString();
    const rev = await manager.saveConsole(
      "revenue",
      "SELECT sum(amount) FROM orders\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: rev._id },
      {
        $set: {
          sharedWith: [{ userId: "collab", role: "editor" }],
          executionCount: 7,
        },
      },
    );
    const content = (await fileAt("consoles/revenue.sql"))!;
    await externalCommit({}, ["consoles/revenue.sql"]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect((await SavedConsole.findById(rev._id))?.is_deleted).toBe(true);
    // The same query, pushed later by another member under a new name.
    await externalCommit({ "consoles/u2-sum.sql": content });
    const stats = await syncConsolesIndexFromRepo(WS, U2);
    expect(stats).toMatchObject({ renamed: 0, created: 1, restored: 0 });
    const old = await SavedConsole.findById(rev._id);
    expect(old?.is_deleted).toBe(true);
    expect(old?.path).toBe("consoles/revenue.sql");
    const fresh = await SavedConsole.findOne({
      workspaceId: WS,
      path: "consoles/u2-sum.sql",
    });
    expect(fresh?._id.toString()).not.toBe(rev._id.toString());
    expect(fresh?.sharedWith ?? []).toEqual([]);
    // Back at its OWN path, the row is restored (id, shares, telemetry).
    await externalCommit({ "consoles/revenue.sql": content });
    expect(await syncConsolesIndexFromRepo(WS, USER)).toMatchObject({
      restored: 1,
      created: 0,
    });
    const back = await SavedConsole.findById(rev._id);
    expect(back?.is_deleted).toBe(false);
    expect(back?.executionCount).toBe(7);
  });

  it("LAPTOP: a live console moved onto a soft-deleted console's path keeps its own row; the dead row lets go", async () => {
    const old = await manager.saveConsole(
      "old",
      "SELECT 'old' AS o\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "private", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: old._id },
      { $set: { sharedWith: [{ userId: "collab1", role: "viewer" }] } },
    );
    const oldPath = (await SavedConsole.findById(old._id))!.path!;
    await externalCommit({}, [oldPath]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect((await SavedConsole.findById(old._id))?.is_deleted).toBe(true);
    const report = await manager.saveConsole(
      "report",
      "SELECT 'secret report' AS r\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "private", language: "sql" },
    );
    const reportPath = (await SavedConsole.findById(report._id))!.path!;
    const content = (await fileAt(reportPath))!;
    // git mv report.sql old.sql
    await externalCommit({ [oldPath]: content }, [reportPath]);
    const stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({
      renamed: 1,
      restored: 0,
      deleted: 0,
      created: 0,
    });
    const r = await SavedConsole.findById(report._id);
    expect(r?.path).toBe(oldPath);
    expect(r?.is_deleted).not.toBe(true);
    expect(r?.sharedWith ?? []).toEqual([]);
    const o = await SavedConsole.findById(old._id);
    expect(o?.is_deleted).toBe(true);
    expect(o?.path).toBeUndefined();
    expect((await loadLiveConsoles(WS)).map(l => l.id.toString())).toEqual([
      report._id.toString(),
    ]);
  });

  it("UI: renaming onto a soft-deleted console's name takes the path for good; a restore picks a free name", async () => {
    const report = await manager.saveConsole(
      "report",
      "SELECT 'report' AS r\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "private", language: "sql" },
    );
    const old = await manager.saveConsole(
      "old",
      "SELECT 'old' AS o\n",
      WS,
      USER,
      undefined,
      "analytics",
      undefined,
      { access: "private", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: old._id },
      { $set: { sharedWith: [{ userId: "collab1", role: "viewer" }] } },
    );
    const oldPath = (await SavedConsole.findById(old._id))!.path!;
    await externalCommit({}, [oldPath]);
    await syncConsolesIndexFromRepo(WS, USER);
    const moved = await manager.relocateConsole(
      report._id.toString(),
      WS,
      { name: "old" },
      { userId: USER },
    );
    expect(moved?.row.path).toBe(oldPath);
    expect((await SavedConsole.findById(old._id))?.path).toBeUndefined();
    // The next push restores nothing: one live row on the file.
    await externalCommit({ "README2.md": "y\n" });
    expect(await syncConsolesIndexFromRepo(WS, USER)).toMatchObject({
      restored: 0,
      deleted: 0,
      created: 0,
    });
    const live = await loadLiveConsoles(WS);
    expect(live.map(l => [l.path, l.id.toString()])).toEqual([
      [oldPath, report._id.toString()],
    ]);
    expect(await fileAt(oldPath)).toContain("'report'");
    // Restoring the deleted console does not overwrite that file.
    expect(await manager.restoreConsole(old._id.toString(), WS, USER)).toBe(
      true,
    );
    const restored = await SavedConsole.findById(old._id);
    expect(restored?.is_deleted).toBe(false);
    expect(restored?.name).toBe("old (2)");
    expect(restored?.path).toBe(`users/${USER}/consoles/old (2).sql`);
    expect(await fileAt(oldPath)).toContain("'report'");
    expect(await fileAt(`users/${USER}/consoles/old (2).sql`)).toContain(
      "'old'",
    );
  });

  it("a new file at a renamed git-born console's old path gets its own row (derived id generations)", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await externalCommit({ "consoles/report.sql": "SELECT 'original'\n" });
    await syncConsolesIndexFromRepo(WS, USER);
    const derived = derivedConsoleId(WS, "consoles/report.sql").toString();
    expect((await SavedConsole.findById(derived))?.path).toBe(
      "consoles/report.sql",
    );
    await manager.relocateConsole(
      derived,
      WS,
      { name: "report-old" },
      { userId: USER },
    );
    expect((await SavedConsole.findById(derived))?.path).toBe(
      "consoles/report-old.sql",
    );
    // Before any sync, the list already hands the new file its own id…
    await externalCommit({ "consoles/report.sql": "SELECT 'brand new'\n" });
    const listed = await loadLiveConsoles(WS);
    const newListed = listed.find(l => l.path === "consoles/report.sql");
    expect(newListed?.id.toString()).not.toBe(derived);
    expect(newListed?.id.toString()).toBe(
      derivedConsoleId(WS, "consoles/report.sql", 2).toString(),
    );
    // …and the sync creates the row under that very id.
    expect(await syncConsolesIndexFromRepo(WS, USER)).toMatchObject({
      created: 1,
      renamed: 0,
      deleted: 0,
    });
    const fresh = await SavedConsole.find({ path: "consoles/report.sql" });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?._id.toString()).toBe(newListed?.id.toString());
    expect((await SavedConsole.findById(derived))?.path).toBe(
      "consoles/report-old.sql",
    );
    expect(
      (await loadLiveConsoles(WS))
        .map(l => `${l.path}->${l.id.toString() === derived ? "old" : "new"}`)
        .sort(),
    ).toEqual(["consoles/report-old.sql->old", "consoles/report.sql->new"]);
  });

  it("a soft-deleted console cannot be renamed: nothing is committed, nothing comes back", async () => {
    const a = await manager.saveConsole(
      "a",
      "SELECT 'saved a'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: a._id },
      { $set: { code: "SELECT 'UNSAVED DRAFT of a'\n" } },
    );
    await manager.softDeleteConsole(a._id.toString(), WS, USER);
    const b = await manager.saveConsole(
      "b",
      "SELECT 'b'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await manager.relocateConsole(
      b._id.toString(),
      WS,
      { name: "a" },
      { userId: USER },
    );
    expect((await SavedConsole.findById(a._id))?.path).toBeUndefined();
    const before = (await log(repoDirFor(WS), MAIN, 50)).length;
    expect(
      await manager.renameConsole(a._id.toString(), "a-again", WS, USER),
    ).toBe(false);
    expect(
      await manager.relocateConsole(
        a._id.toString(),
        WS,
        { name: "a-again" },
        { userId: USER },
      ),
    ).toBeNull();
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(before);
    expect(await fileAt("consoles/a-again.sql")).toBeNull();
    await syncConsolesIndexFromRepo(WS, USER);
    const row = await SavedConsole.findById(a._id);
    expect(row?.is_deleted).toBe(true);
    expect(row?.path).toBeUndefined();
  });

  it("a rename pair never crosses an ownership boundary, even for an identical blob", async () => {
    const U2 = new Types.ObjectId().toString();
    const shared = await manager.saveConsole(
      "team metrics",
      "SELECT team, count(*) FROM members GROUP BY 1\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne(
      { _id: shared._id },
      { $set: { sharedWith: [{ userId: "collab", role: "editor" }] } },
    );
    const contents = (await fileAt("consoles/team metrics.sql"))!;
    // Someone moves the file into U2's private tree in one push.
    await externalCommit(
      { [`users/${U2}/consoles/team metrics.sql`]: contents },
      ["consoles/team metrics.sql"],
    );
    const stats = await syncConsolesIndexFromRepo(WS, U2);
    expect(stats).toMatchObject({ renamed: 0, created: 1, deleted: 1 });
    expect((await SavedConsole.findById(shared._id))?.is_deleted).toBe(true);
    const mine = await SavedConsole.findOne({
      workspaceId: WS,
      path: `users/${U2}/consoles/team metrics.sql`,
    });
    expect(mine?.owner_id).toBe(U2);
    expect(mine?.sharedWith ?? []).toEqual([]);
  });

  it("rename detection runs only when a live orphan AND an unclaimed new file coexist", async () => {
    const gone = await manager.saveConsole(
      "gone",
      "SELECT 'gone'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit({}, ["consoles/gone.sql"]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect((await SavedConsole.findById(gone._id))?.is_deleted).toBe(true);
    spies.detect.mockClear();
    // A soft-deleted orphan plus a brand-new file: nothing to detect.
    await externalCommit({ "consoles/fresh.sql": "SELECT 'fresh'\n" });
    await syncConsolesIndexFromRepo(WS, USER);
    expect(spies.detect).not.toHaveBeenCalled();
    // A live orphan but no unclaimed file (a plain deletion): nothing either.
    const live = await manager.saveConsole(
      "live",
      "SELECT 'live'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit({}, ["consoles/live.sql"]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect(spies.detect).not.toHaveBeenCalled();
    expect((await SavedConsole.findById(live._id))?.is_deleted).toBe(true);
    // Both at once: one detection, scoped to the live orphan only.
    const moving = await manager.saveConsole(
      "moving",
      "SELECT country, count(*) AS n\nFROM leads\nWHERE created_at > now() - interval '7 days'\nGROUP BY 1\nORDER BY 2 DESC\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit(
      {
        "consoles/moved.sql":
          "SELECT country, count(*) AS n\nFROM leads\nWHERE created_at > now() - interval '14 days'\nGROUP BY 1\nORDER BY 2 DESC\n",
      },
      ["consoles/moving.sql"],
    );
    await syncConsolesIndexFromRepo(WS, USER);
    expect(spies.detect).toHaveBeenCalledTimes(1);
    expect(spies.detect.mock.calls[0]?.[2]).toEqual(["consoles/moving.sql"]);
    expect((await SavedConsole.findById(moving._id))?.path).toBe(
      "consoles/moved.sql",
    );
  });

  it("a GET of a soft-deleted console never syncs; concurrent stale reads share one sync", async () => {
    const dead = await manager.saveConsole(
      "dead",
      "SELECT 'dead'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit({}, ["consoles/dead.sql"]);
    await syncConsolesIndexFromRepo(WS, USER);
    expect((await SavedConsole.findById(dead._id))?.is_deleted).toBe(true);
    spies.serialized.mockClear();
    expect(await loadLiveConsoleById(WS, dead._id.toString())).toBeNull();
    expect(await loadLiveConsoleById(WS, dead._id.toString())).toBeNull();
    expect(spies.serialized).not.toHaveBeenCalled();

    const stale = await manager.saveConsole(
      "stale2",
      "SELECT 'stale'\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const contents = (await fileAt("consoles/stale2.sql"))!;
    await externalCommit({ "consoles/Moved/stale2.sql": contents }, [
      "consoles/stale2.sql",
    ]);
    spies.serialized.mockClear();
    const hits = await Promise.all([
      loadLiveConsoleById(WS, stale._id.toString()),
      loadLiveConsoleById(WS, stale._id.toString()),
      loadLiveConsoleById(WS, stale._id.toString()),
    ]);
    for (const hit of hits) {
      expect(hit && "live" in hit ? hit.live.path : null).toBe(
        "consoles/Moved/stale2.sql",
      );
    }
    expect(spies.serialized).toHaveBeenCalledTimes(1);

    // A row a sync cannot heal (here: the repo is no longer adopted, so the
    // sync is a no-op) is not re-synced per read while main has not moved.
    await externalCommit({ "consoles/Elsewhere/stale2.sql": contents }, [
      "consoles/Moved/stale2.sql",
      CONSOLES_README_PATH,
    ]);
    spies.serialized.mockClear();
    expect(await loadLiveConsoleById(WS, stale._id.toString())).toBeNull();
    expect(await loadLiveConsoleById(WS, stale._id.toString())).toBeNull();
    expect(spies.serialized).toHaveBeenCalledTimes(1);
    // …and a new push (main moved) is tried again.
    await externalCommit({ "README.md": "y\n" });
    expect(await loadLiveConsoleById(WS, stale._id.toString())).toBeNull();
    expect(spies.serialized).toHaveBeenCalledTimes(2);
  });

  it("a rewritten file (nothing like the old one) is a delete + create, not a guess", async () => {
    const saved = await manager.saveConsole(
      "alpha",
      "SELECT 1 AS alpha_only_marker_row\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    await externalCommit(
      {
        "consoles/beta.sql":
          "-- entirely different content\nSELECT id, name, email, created_at FROM customers WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100\n",
      },
      ["consoles/alpha.sql"],
    );
    const stats = await syncConsolesIndexFromRepo(WS, USER);
    expect(stats).toMatchObject({ renamed: 0, created: 1, deleted: 1 });
    expect((await SavedConsole.findById(saved._id))?.is_deleted).toBe(true);
  });

  it("a GET by id between a push and its sync heals the stale path instead of 404ing", async () => {
    const saved = await manager.saveConsole(
      "stale",
      "SELECT 'between push and sync' AS note\n",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    const contents = (await fileAt("consoles/stale.sql"))!;
    await externalCommit({ "consoles/Moved/stale.sql": contents }, [
      "consoles/stale.sql",
    ]);
    // No sync ran: the row still says consoles/stale.sql.
    expect((await SavedConsole.findById(saved._id))?.path).toBe(
      "consoles/stale.sql",
    );
    const hit = await loadLiveConsoleById(WS, saved._id.toString());
    expect(hit && "live" in hit ? hit.live.path : null).toBe(
      "consoles/Moved/stale.sql",
    );
    expect((await SavedConsole.findById(saved._id))?.path).toBe(
      "consoles/Moved/stale.sql",
    );
    // A row whose file really is gone still answers null.
    await externalCommit({}, ["consoles/Moved/stale.sql"]);
    expect(await loadLiveConsoleById(WS, saved._id.toString())).toBeNull();
  });

  it("never touches a workspace that has not adopted", async () => {
    // A repo exists (an app was created) but consoles were never adopted:
    // Mongo may hold consoles git has never seen.
    await SavedConsole.create({
      workspaceId: WS,
      name: "legacy",
      code: "SELECT 1",
      language: "sql",
      createdBy: USER,
      owner_id: USER,
      isSaved: true,
      access: "workspace",
      isPrivate: false,
      executionCount: 0,
      path: "consoles/legacy.sql",
      sourceBlobSha: "x",
    });
    expect(await syncConsolesIndexFromRepo(WS, USER)).toBeNull();
    expect(
      (await SavedConsole.findOne({ name: "legacy" }))?.is_deleted,
    ).not.toBe(true);
  });
});

describe("descriptions are content-addressed", () => {
  it("skips when derived from the current blob, marks authored text without an LLM", async () => {
    const saved = await manager.saveConsole(
      "d",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      {
        access: "workspace",
        language: "sql",
        description: "Typed by a human",
      },
    );
    // Authored: no LLM needed, stamped as derived from this blob even
    // without an embedding provider.
    expect(await deriveConsoleDescription(saved._id.toString())).toBe(
      "updated",
    );
    const row = await SavedConsole.findById(saved._id);
    expect(row?.descriptionSource).toBe("authored");
    expect(row?.descriptionSourceSha).toBe(row?.sourceBlobSha);
    expect(await deriveConsoleDescription(saved._id.toString())).toBe(
      "current",
    );

    // Content moves → stale again; with no LLM configured the generated
    // path reports unavailable rather than writing anything.
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { description: "", descriptionSource: "generated" } },
    );
    const fresh = (await SavedConsole.findById(saved._id))!;
    fresh.code = "SELECT 2";
    const committed = await commitConsoleState({
      row: fresh,
      previousPath: fresh.path,
      actorUserId: USER,
      message: "save: d",
    });
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { code: "SELECT 2", sourceBlobSha: committed.sourceBlobSha } },
    );
    expect(await deriveConsoleDescription(saved._id.toString())).toBe(
      "unavailable",
    );
    expect(
      (await SavedConsole.findById(saved._id))?.descriptionSourceSha,
    ).not.toBe(committed.sourceBlobSha);
  });

  it("a stale result never overwrites a newer file", async () => {
    const saved = await manager.saveConsole(
      "r",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      {
        access: "workspace",
        language: "sql",
        description: "v1",
      },
    );
    // Simulate: derivation read the row at sha A, the file moved to sha B
    // before the write. The guard on sourceBlobSha refuses the write.
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { sourceBlobSha: "b".repeat(40) } },
    );
    const rowAtA = await SavedConsole.findById(saved._id);
    expect(rowAtA?.sourceBlobSha).toBe("b".repeat(40));
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { sourceBlobSha: saved.sourceBlobSha } },
    );
    // Direct check of the guard: a write claiming sha A against a row at B.
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { sourceBlobSha: "b".repeat(40) } },
    );
    const res = await SavedConsole.updateOne(
      { _id: saved._id, sourceBlobSha: saved.sourceBlobSha },
      { $set: { description: "stale" } },
    );
    expect(res.matchedCount).toBe(0);
  });
});

describe("adoption", () => {
  it("replays versions as commits, keeps embeddings, is re-runnable", async () => {
    const id = new Types.ObjectId();
    await SavedConsole.create({
      _id: id,
      workspaceId: WS,
      name: "Churn",
      code: "SELECT 3",
      language: "sql",
      createdBy: USER,
      owner_id: USER,
      isSaved: true,
      access: "workspace",
      isPrivate: false,
      executionCount: 3,
      description: "generated earlier",
      descriptionGeneratedAt: new Date(),
      descriptionEmbedding: [0.5],
      embeddingModel: "text-embedding-3-small",
    });
    const t0 = new Date("2026-05-01T10:00:00Z");
    // v2 is deliberately file-identical to v1 (a metadata-only save): it
    // must STILL become a commit — its message and author are the record.
    for (const [i, code] of ["SELECT 1", "SELECT 1", "SELECT 3"].entries()) {
      await EntityVersion.create({
        workspaceId: WS,
        entityType: "console",
        entityId: id,
        version: i + 1,
        snapshot: { name: "Churn", code, language: "sql", access: "workspace" },
        savedBy: USER,
        savedByName: "someone@example.com",
        comment: i === 1 ? "tightened the filter" : "",
        createdAt: new Date(t0.getTime() + i * 3600_000),
      });
    }
    // A draft must not be adopted.
    await SavedConsole.create({
      workspaceId: WS,
      name: "Untitled",
      code: "select",
      language: "sql",
      createdBy: USER,
      owner_id: USER,
      isSaved: false,
      access: "private",
      isPrivate: true,
      executionCount: 0,
    });

    const report = await adoptWorkspaceConsoles(WS, { replayHistory: true });
    expect(report).toMatchObject({
      consoles: 1,
      versionsReplayed: 3,
      adopted: true,
    });
    const history = (await log(repoDirFor(WS), MAIN, 20)).reverse();
    const subjects = history.map(c => c.subject);
    expect(subjects).toEqual(
      expect.arrayContaining(["v1", "tightened the filter", "v3"]),
    );
    // The last version equals the live state: no extra "adopt current state" commit.
    expect(subjects.some(s => s.startsWith("Adopt current state"))).toBe(false);
    const v2 = history.find(c => c.subject === "tightened the filter")!;
    expect(new Date(v2.timestamp).toISOString()).toBe(
      "2026-05-01T11:00:00.000Z",
    );
    expect(v2.author).toBe("someone@example.com");
    expect(await treePaths()).toEqual(
      expect.arrayContaining(["consoles/Churn.sql", CONSOLES_README_PATH]),
    );
    expect(await treePaths()).not.toContain(
      `users/${USER}/consoles/Untitled.sql`,
    );

    const row = await SavedConsole.findById(id).select("+descriptionEmbedding");
    expect(row?.path).toBe("consoles/Churn.sql");
    expect(row?.sourceBlobSha).toBe(
      blobOid((await fileAt("consoles/Churn.sql"))!),
    );
    expect(row?.descriptionEmbedding).toEqual([0.5]);
    expect(row?.descriptionSourceSha).toBe(row?.sourceBlobSha);
    expect(row?.descriptionSource).toBe("generated");
    // A generated description stays out of the file.
    expect(
      parseConsoleFile((await fileAt("consoles/Churn.sql"))!, "sql").meta
        .description,
    ).toBeUndefined();

    const commitsBefore = (await log(repoDirFor(WS), MAIN, 50)).length;
    const again = await adoptWorkspaceConsoles(WS, { replayHistory: true });
    expect(again).toMatchObject({ alreadyCurrent: 1, commits: 0 });
    expect((await log(repoDirFor(WS), MAIN, 50)).length).toBe(commitsBefore);
  });

  it("two consoles that sanitize to one path get distinct files", async () => {
    for (const name of ["a/b", "a b"]) {
      await SavedConsole.create({
        workspaceId: WS,
        name,
        code: `SELECT '${name}'`,
        language: "sql",
        createdBy: USER,
        owner_id: USER,
        isSaved: true,
        access: "workspace",
        isPrivate: false,
        executionCount: 0,
      });
    }
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    const paths = (await treePaths()).filter(
      p => p.startsWith("consoles/") && p.endsWith(".sql"),
    );
    expect(paths).toEqual(["consoles/a b (2).sql", "consoles/a b.sql"]);
    const rows = await SavedConsole.find({ workspaceId: WS });
    expect(new Set(rows.map(r => r.path)).size).toBe(2);
  });
});

describe("history — the apps surface for a console", () => {
  it("lists commits for the file, shows what one changed, diffs, and restores as a new commit", async () => {
    const saved = await manager.saveConsole(
      "h",
      "SELECT 1",
      WS,
      USER,
      "68471be56e70c184bbc6cceb",
      "db",
      undefined,
      {
        access: "workspace",
        language: "sql",
      },
    );
    const v1 = await SavedConsole.findById(saved._id);
    v1!.code = "SELECT 2";
    const second = await commitConsoleState({
      row: v1!,
      previousPath: v1!.path,
      actorUserId: USER,
      message: "second",
    });
    await SavedConsole.updateOne(
      { _id: saved._id },
      { $set: { code: "SELECT 2", sourceBlobSha: second.sourceBlobSha } },
    );

    const row = (await SavedConsole.findById(saved._id))!;
    const history = await consoleHistory(row);
    expect(history.map(c => c.subject)).toEqual(["second", "create: h"]);

    const changes = await consoleCommitChanges(row, history[0].oid);
    expect(changes.files).toEqual([
      { path: "consoles/h.sql", status: "modified" },
    ]);
    const versions = await consoleFileVersions(
      row,
      history[0].oid,
      "consoles/h.sql",
    );
    expect(versions.before).toContain("SELECT 1");
    expect(versions.after).toContain("SELECT 2");
    expect(versions.after).toContain("-- connection: 68471be56e70c184bbc6cceb");

    // Restore v1: a NEW commit, the row follows, history keeps everything.
    const versionBefore = row.version;
    const restored = await restoreConsoleTo(row, history[1].oid, USER);
    expect(restored.unchanged).toBe(false);
    const after = (await SavedConsole.findById(saved._id))!;
    expect(after.code).toBe("SELECT 1");
    expect(after.connectionId?.toString()).toBe("68471be56e70c184bbc6cceb");
    expect(after.version).toBe(versionBefore + 1);
    const subjects = (await consoleHistory(after)).map(c => c.subject);
    expect(subjects[0]).toMatch(/^Restore "create: h" \(/);
    expect(subjects).toHaveLength(3);
    expect(await fileAt("consoles/h.sql")).toContain("SELECT 1");
  });

  it("does not list leftover local git history when no GitHub repo is bound", async () => {
    const saved = await manager.saveConsole(
      "orphan-hist",
      "SELECT leftover",
      WS,
      USER,
      "68471be56e70c184bbc6cceb",
      "db",
      undefined,
      { access: "workspace", language: "sql" },
    );
    const row = (await SavedConsole.findById(saved._id))!;
    expect(await consoleHistory(row)).not.toEqual([]);
    await unbindTestWorkspaceRepo(WS);
    expect(await consoleHistory(row)).toEqual([]);
  });
});

function flattenConsoles(nodes: ConsoleFile[]): ConsoleFile[] {
  const out: ConsoleFile[] = [];
  for (const node of nodes) {
    if (node.isDirectory) out.push(...flattenConsoles(node.children ?? []));
    else out.push(node);
  }
  return out;
}

describe("GET/list from git", () => {
  it("serves the file at main when the Mongo row has no body", async () => {
    const saved = await manager.saveConsole(
      "body-from-git",
      "SELECT 'git-body'",
      WS,
      USER,
      "68471be56e70c184bbc6cceb",
      "db",
      undefined,
      { access: "workspace", language: "sql" },
    );
    await SavedConsole.updateOne({ _id: saved._id }, { $set: { code: "" } });
    const mongo = await SavedConsole.findById(saved._id);
    expect(mongo?.code).toBe("");

    const listed = flattenConsoles(await manager.listConsoles(WS, USER));
    const hit = listed.find(c => c.name === "body-from-git");
    expect(hit?.content).toContain("SELECT 'git-body'");

    const meta = await manager.getConsoleWithMetadata(saved._id.toString(), WS);
    expect(meta?.content).toContain("SELECT 'git-body'");
  });

  it("lists a git file that has no Mongo row", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await externalCommit({
      "consoles/from-laptop.sql": "SELECT 42 -- laptop\n",
    });
    const listed = flattenConsoles(await manager.listConsoles(WS, USER));
    const hit = listed.find(c => c.name === "from-laptop");
    expect(hit).toBeTruthy();
    expect(hit?.content).toContain("SELECT 42");
  });

  it("never reconciles or soft-deletes Mongo as a side effect of listing", async () => {
    const saved = await manager.saveConsole(
      "removed-elsewhere",
      "SELECT 1",
      WS,
      USER,
      undefined,
      undefined,
      undefined,
      { access: "workspace", language: "sql" },
    );
    expect(saved.path).toBeTruthy();
    await externalCommit({}, [saved.path as string]);

    expect(await manager.listConsoles(WS, USER)).toEqual([]);
    const row = await SavedConsole.findById(saved._id);
    expect(row?.is_deleted).not.toBe(true);
  });

  it("shares one cold git definition load across concurrent list requests", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await externalCommit({
      "consoles/cold-load.sql": "SELECT 42\n",
    });

    const [first, second, third] = await Promise.all([
      listConsoleDefinitionsAtMain(WS),
      listConsoleDefinitionsAtMain(WS),
      listConsoleDefinitionsAtMain(WS),
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("does not list a Mongo row that has no git file", async () => {
    await adoptWorkspaceConsoles(WS, { replayHistory: false });
    await SavedConsole.create({
      workspaceId: WS,
      name: "mongo-only",
      code: "SELECT 'should-not-appear'",
      language: "sql",
      createdBy: USER,
      owner_id: USER,
      isSaved: true,
      access: "workspace",
      isPrivate: false,
      executionCount: 0,
      version: 1,
      draftRevision: 1,
    });
    const listed = flattenConsoles(await manager.listConsoles(WS, USER));
    expect(listed.map(c => c.name)).not.toContain("mongo-only");
  });

  it("does not list leftover local git or Mongo when no GitHub repo is bound", async () => {
    const saved = await manager.saveConsole(
      "leftover-list",
      "SELECT leftover",
      WS,
      USER,
      "68471be56e70c184bbc6cceb",
      "db",
      undefined,
      { access: "workspace", language: "sql" },
    );
    expect(
      flattenConsoles(await manager.listConsoles(WS, USER)).map(c => c.name),
    ).toContain("leftover-list");
    expect(await fileAt(saved.path!)).toContain("SELECT leftover");

    await unbindTestWorkspaceRepo(WS);
    expect(await manager.listConsoles(WS, USER)).toEqual([]);
    expect(await manager.listConsolesFlat(WS, USER)).toEqual([]);
    const leftoverPath = saved.path;
    expect(leftoverPath).toBeTruthy();
    expect(await fileAt(leftoverPath as string)).toContain("SELECT leftover");
    expect(await SavedConsole.findById(saved._id)).not.toBeNull();
  });
});

describe("route-side projection", () => {
  it("treats undefined like $set does — unchanged, not cleared", async () => {
    const saved = await manager.saveConsole(
      "p",
      "SELECT 1",
      WS,
      USER,
      "68471be56e70c184bbc6cceb",
      "db",
      undefined,
      {
        access: "workspace",
        language: "sql",
        description: "keep me",
      },
    );
    const current = (await SavedConsole.findById(saved._id))!;
    // What the explicit-save handler sends when the client omits a field.
    const projected = await projectSavedConsole({
      workspaceId: WS,
      current,
      set: {
        code: "SELECT 2",
        connectionId: undefined,
        databaseName: undefined,
      },
      actorUserId: USER,
      message: "save: p",
    });
    const file = (await fileAt(projected.path))!;
    expect(file).toContain("-- connection: 68471be56e70c184bbc6cceb");
    expect(file).toContain("-- database: db");
    expect(file).toContain("-- description: keep me");
    expect(file).toContain("SELECT 2");

    // A lost guard reverts to the previous file, as a commit.
    await projected.revert();
    expect(await fileAt(projected.path)).toContain("SELECT 1");
    const subjects = (await log(repoDirFor(WS), MAIN, 5)).map(c => c.subject);
    expect(subjects[0]).toBe(`revert: ${projected.path}`);
  });
});
