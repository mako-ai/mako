/**
 * Notebook checkpoints in the workspace repo (apps.md §24): real bare repo,
 * real filesystem notebook store, mongodb-memory-server for the index.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { NotebookIndex } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  log as repoLog,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { getNotebookStore } from "./store";
import {
  notebookRepoPath,
  parseNotebookFile,
  serializeNotebookFile,
} from "./deepnote-file";
import {
  adoptWorkspaceNotebooks,
  checkpointNotebook,
  notebookHistory,
  removeNotebookFile,
  syncNotebooksFromRepo,
} from "./notebook-git.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-git-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.NOTEBOOK_WORKDIR = path.join(tmpRoot, "notebooks");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.NOTEBOOK_GCS_BUCKET;
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
  await NotebookIndex.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "notebooks"), {
    recursive: true,
    force: true,
  });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

async function seedNotebook(name: string, access: "private" | "workspace") {
  const store = getNotebookStore();
  const doc = await store.create(WS, { name });
  await store.update(WS, doc.id, {
    blocks: [
      { id: "b1", type: "markdown", source: `# ${name}` },
      { id: "b2", type: "sql", source: "select 1", connectionId: "conn-1" },
      {
        id: "b3",
        type: "code",
        source: "print('hi')",
        outputs: [{ type: "stream", name: "stdout", text: "hi" }],
        executionCount: 3,
      },
    ],
  });
  await NotebookIndex.create({
    workspaceId: new Types.ObjectId(WS),
    notebookId: doc.id,
    name,
    ownerId: "u1",
    access,
    updatedAt: new Date(),
  });
  return doc.id;
}

async function fileAt(rel: string): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), MAIN, rel);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

describe("checkpoint", () => {
  it("skips leftover local git when no GitHub repo is bound", async () => {
    await unbindTestWorkspaceRepo(WS);
    const id = await seedNotebook("Orphan", "workspace");
    const result = await checkpointNotebook(WS, id, "u1");
    expect(result).toEqual({
      committed: false,
      skippedReason: "no_repository",
    });
    expect(await fileAt("notebooks/orphan.deepnote")).toBeNull();
  });

  it("does not list leftover local git history when no GitHub repo is bound", async () => {
    const id = await seedNotebook("History leak", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const index = await NotebookIndex.findOne({ notebookId: id });
    expect(index?.path).toBeTruthy();
    expect(await notebookHistory(index!)).not.toEqual([]);
    await unbindTestWorkspaceRepo(WS);
    expect(await notebookHistory(index!)).toEqual([]);
  });

  it("commits a stripped single-notebook .deepnote at the access-scoped path", async () => {
    const id = await seedNotebook("Revenue walk", "workspace");
    const result = await checkpointNotebook(WS, id, "u1");
    expect(result.committed).toBe(true);

    const contents = await fileAt("notebooks/revenue-walk.deepnote");
    expect(contents).toBeTruthy();
    expect(contents).toContain("version: 1.0.0");
    expect(contents).toContain("type: sql");
    expect(contents).toContain("mako_connection_id: conn-1");
    // Outputs are STRIPPED (Deepnote's own source-vs-snapshot split).
    expect(contents).not.toContain("stdout");
    expect(contents).not.toContain("executionCount");

    // Idempotent: same content → no second commit.
    const again = await checkpointNotebook(WS, id, "u1");
    expect(again.committed).toBe(false);
  });

  it("a private notebook lands under users/<owner>/notebooks/", async () => {
    const id = await seedNotebook("Scratch pad", "private");
    await checkpointNotebook(WS, id, "u1");
    expect(
      await fileAt("users/u1/notebooks/scratch-pad.deepnote"),
    ).toBeTruthy();
  });

  it("an access flip moves the file in one commit", async () => {
    const id = await seedNotebook("Shared later", "private");
    await checkpointNotebook(WS, id, "u1");
    await NotebookIndex.updateOne(
      { notebookId: id },
      { $set: { access: "workspace" } },
    );
    await checkpointNotebook(WS, id, "u1");
    expect(await fileAt("users/u1/notebooks/shared-later.deepnote")).toBeNull();
    expect(await fileAt("notebooks/shared-later.deepnote")).toBeTruthy();
    const [head] = await repoLog(repoDirFor(WS), MAIN, 1);
    expect(head.subject).toContain("move to notebooks/shared-later.deepnote");
  });

  it("removeNotebookFile deletes the committed file", async () => {
    const id = await seedNotebook("Doomed", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const index = await NotebookIndex.findOne({ notebookId: id });
    await removeNotebookFile(WS, index!, "u1");
    expect(await fileAt("notebooks/doomed.deepnote")).toBeNull();
  });
});

describe("push-sync", () => {
  it("an external .deepnote edit flows into the store when the doc is level", async () => {
    const id = await seedNotebook("Synced", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const raw = (await fileAt("notebooks/synced.deepnote"))!;
    const parsed = parseNotebookFile(raw)!;
    parsed.blocks[0] = { ...parsed.blocks[0], source: "# Synced (edited)" };
    const doc = await getNotebookStore().get(WS, id);
    const edited = serializeNotebookFile({
      ...doc!,
      name: "Synced",
      blocks: parsed.blocks,
    });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "notebooks/synced.deepnote": edited } },
      { message: "laptop edit" },
    );
    await syncNotebooksFromRepo(WS);
    const fresh = await getNotebookStore().get(WS, id);
    expect(fresh?.blocks[0]?.source).toBe("# Synced (edited)");
  });

  it("the live editor wins over a stale external edit", async () => {
    const id = await seedNotebook("Contended", "workspace");
    await checkpointNotebook(WS, id, "u1");
    // Live edit AFTER the checkpoint…
    await getNotebookStore().update(WS, id, {
      blocks: [{ id: "b1", type: "markdown", source: "# LIVE WORK" }],
    });
    // …and an external edit landing on the OLD checkpoint.
    const doc = await getNotebookStore().get(WS, id);
    const external = serializeNotebookFile({
      ...doc!,
      name: "Contended",
      blocks: [{ id: "b1", type: "markdown", source: "# EXTERNAL" }],
    });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "notebooks/contended.deepnote": external } },
      { message: "stale laptop edit" },
    );
    await syncNotebooksFromRepo(WS);
    const fresh = await getNotebookStore().get(WS, id);
    expect(fresh?.blocks[0]?.source).toBe("# LIVE WORK");
  });
});

describe("laptop renames (git mv pushed from a checkout)", () => {
  it("a moved .deepnote re-keys its index row by the id the file carries, and the path sticks", async () => {
    const id = await seedNotebook("Quarterly", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const raw = (await fileAt("notebooks/quarterly.deepnote"))!;
    // `git mv notebooks/quarterly.deepnote notebooks/q3-review.deepnote`
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "notebooks/q3-review.deepnote": raw },
        deletes: ["notebooks/quarterly.deepnote"],
      },
      { message: "laptop rename" },
    );
    await syncNotebooksFromRepo(WS);
    const index = await NotebookIndex.findOne({ notebookId: id });
    expect(index?.path).toBe("notebooks/q3-review.deepnote");
    expect(index?.name).toBe("Quarterly");
    expect(await NotebookIndex.countDocuments({ workspaceId: WS })).toBe(1);
    // The next checkpoint must NOT move the file back to the name's slug.
    const result = await checkpointNotebook(WS, id, "u1");
    expect(result.committed).toBe(false);
    expect(await fileAt("notebooks/q3-review.deepnote")).not.toBeNull();
    expect(await fileAt("notebooks/quarterly.deepnote")).toBeNull();
    // …until the name itself changes in the UI, which derives a new path.
    await NotebookIndex.updateOne({ notebookId: id }, { name: "Q3 Review" });
    const moved = await checkpointNotebook(WS, id, "u1");
    expect(moved.committed).toBe(true);
    expect(moved.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(await fileAt("notebooks/q3-review.deepnote")).not.toBeNull();
    expect((await NotebookIndex.findOne({ notebookId: id }))?.path).toBe(
      "notebooks/q3-review.deepnote",
    );
  });

  it("a moved AND edited file keeps its row by the id it carries (rename + edit in one push)", async () => {
    const id = await seedNotebook("Research notes", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const raw = (await fileAt("notebooks/research-notes.deepnote"))!;
    const edited = raw.replace("# Research notes", "# Research notes (v2)");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "notebooks/research.deepnote": edited },
        deletes: ["notebooks/research-notes.deepnote"],
      },
      { message: "laptop move + edit" },
    );
    await syncNotebooksFromRepo(WS);
    const index = await NotebookIndex.findOne({ notebookId: id });
    expect(index?.path).toBe("notebooks/research.deepnote");
    const doc = await getNotebookStore().get(WS, id);
    expect(doc?.blocks[0]?.source).toBe("# Research notes (v2)");
    expect(await NotebookIndex.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("a file with a DIFFERENT id is never paired with a vanished row, however similar", async () => {
    const id = await seedNotebook("Team plan", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const raw = (await fileAt("notebooks/team-plan.deepnote"))!;
    const other = raw.replaceAll(id, "00000000-0000-4000-8000-000000000001");
    // Same content, new id, old path gone — in one push.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "notebooks/team-plan-copy.deepnote": other },
        deletes: ["notebooks/team-plan.deepnote"],
      },
      { message: "a copy under a new id replaces the file" },
    );
    await syncNotebooksFromRepo(WS);
    const index = await NotebookIndex.findOne({ notebookId: id });
    expect(index?.path).toBe("notebooks/team-plan.deepnote");
    expect(await NotebookIndex.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("a later file with its OWN id never takes over a live notebook whose file vanished", async () => {
    const alpha = await seedNotebook("Alpha", "workspace");
    await checkpointNotebook(WS, alpha, "u1");
    // A second notebook's file, captured, then its row dropped: an external
    // file with an id Mako does not know.
    const beta = await seedNotebook("Beta", "workspace");
    await checkpointNotebook(WS, beta, "u1");
    const betaRaw = (await fileAt("notebooks/beta.deepnote"))!;
    await NotebookIndex.deleteOne({ notebookId: beta });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: ["notebooks/beta.deepnote", "notebooks/alpha.deepnote"] },
      { message: "files removed from git; alpha lives on in the app" },
    );
    await syncNotebooksFromRepo(WS);
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "notebooks/beta-new.deepnote": betaRaw } },
      { message: "a different notebook lands later" },
    );
    await syncNotebooksFromRepo(WS);
    const index = await NotebookIndex.findOne({ notebookId: alpha });
    expect(index?.path).toBe("notebooks/alpha.deepnote");
    expect(index?.name).toBe("Alpha");
    const doc = await getNotebookStore().get(WS, alpha);
    expect(doc?.name).toBe("Alpha");
    expect(doc?.blocks[0]?.source).toBe("# Alpha");
    expect(await NotebookIndex.countDocuments({ workspaceId: WS })).toBe(1);
  });
});

describe("adoption", () => {
  it("checkpoints every notebook once, re-runnable", async () => {
    await seedNotebook("First", "workspace");
    await seedNotebook("Second", "private");
    const first = await adoptWorkspaceNotebooks(WS);
    expect(first).toEqual({ notebooks: 2, written: 2 });
    expect(await fileAt(notebookRepoPath("first"))).toBeTruthy();
    expect(
      await fileAt(
        notebookRepoPath("second", { access: "private", ownerId: "u1" }),
      ),
    ).toBeTruthy();
    const again = await adoptWorkspaceNotebooks(WS);
    expect(again.written).toBe(0);
  });
});
