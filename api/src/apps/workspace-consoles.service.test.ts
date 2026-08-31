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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  projectSavedConsole,
  restoreConsoleTo,
  syncConsolesIndexFromRepo,
} from "./workspace-consoles.service";
import { ConsoleManager } from "../utils/console-manager";

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

  it("renaming a folder moves every console under it in one commit", async () => {
    const folder = await manager.createFolder(
      "Old",
      WS,
      USER,
      undefined,
      false,
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
    const { initRepo } = await import("./repository.service");
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
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
