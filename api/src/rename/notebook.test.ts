/**
 * Notebook rename — the service, `rename_object` kind `notebook`, and a
 * rename against a delete in both orders. Real bare repo, real filesystem
 * notebook store, mongodb-memory-server for the index.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  NotebookIndex,
  WorkspaceUserHandle,
} from "../database/workspace-schema";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import {
  DEFAULT_BRANCH,
  initRepo,
  listTree,
  log as repoLog,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { invalidateOwnerDirectory } from "../apps/user-handles.service";
import { parseNotebookFile } from "../notebooks/deepnote-file";
import {
  checkpointNotebook,
  notebookCheckpointHooks,
  removeNotebookIndexAndFile,
} from "../notebooks/notebook-git.service";
import { getNotebookStore } from "../notebooks/store";
import { notebookRenameHooks, renameNotebook } from "./notebook";
import { renameObject, resolveObjectRef } from "./registry";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const owner = { workspaceId: WS, userId: "u1", role: "member" };
const other = { workspaceId: WS, userId: "u2", role: "member" };

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-rename-test-"));
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
  notebookCheckpointHooks.beforeCommit = undefined;
  notebookRenameHooks.afterRead = undefined;
  await NotebookIndex.deleteMany({});
  await WorkspaceUserHandle.deleteMany({});
  await WorkspaceUserHandle.create({
    workspaceId: new Types.ObjectId(WS),
    userId: "u1",
    handle: "joan",
  });
  invalidateOwnerDirectory();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "notebooks"), {
    recursive: true,
    force: true,
  });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

/** A checkpointed notebook owned by u1. */
async function seed(
  name: string,
  access: "private" | "workspace" = "workspace",
): Promise<string> {
  const store = getNotebookStore();
  const doc = await store.create(WS, { name });
  await store.update(WS, doc.id, {
    blocks: [{ id: "b1", type: "markdown", source: `# ${name}` }],
  });
  await NotebookIndex.create({
    workspaceId: new Types.ObjectId(WS),
    notebookId: doc.id,
    name,
    ownerId: "u1",
    access,
    updatedAt: new Date(),
  });
  await checkpointNotebook(WS, doc.id, "u1");
  return doc.id;
}

/** Every `.deepnote` on main with the notebook id it carries. */
async function files(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const entry of await listTree(repoDirFor(WS), MAIN)) {
    if (!entry.path.endsWith(".deepnote")) continue;
    const blob = await readBlob(repoDirFor(WS), MAIN, entry.path);
    out[entry.path] = parseNotebookFile(blob.contents)?.id ?? null;
  }
  return out;
}

const rename = (id: string, name: string) =>
  renameNotebook({ workspaceId: WS, notebookId: id, name, actorUserId: "u1" });

/** Hold the next checkpoint (or rename) at its hook until released. */
function hold(
  target: { [key: string]: (() => Promise<void>) | undefined },
  key: string,
) {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => (arrived = resolve));
  const gate = new Promise<void>(resolve => (release = resolve));
  target[key] = async () => {
    target[key] = undefined;
    arrived();
    await gate;
  };
  return { reached, release };
}

describe("renameNotebook", () => {
  it("renames the store, the index and the file in one commit; the id stays", async () => {
    const id = await seed("Draft");
    const before = (await repoLog(repoDirFor(WS), MAIN, 50)).length;
    const renamed = await rename(id, "  Final report  ");
    expect(renamed.index.name).toBe("Final report");
    expect(renamed.index.path).toBe("notebooks/final-report.deepnote");
    expect(renamed.doc.id).toBe(id);
    expect(await files()).toEqual({ "notebooks/final-report.deepnote": id });
    const commits = await repoLog(repoDirFor(WS), MAIN, 50);
    expect(commits.length).toBe(before + 1);
    expect(commits[0].oid).toBe(renamed.commit);
  });

  it("two renames at once converge: one name everywhere, one file", async () => {
    const id = await seed("Draft");
    const results = await Promise.allSettled([
      rename(id, "Alpha"),
      rename(id, "Beta"),
    ]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const index = await NotebookIndex.findOne({ notebookId: id });
    expect(index?.name).toBe("Beta");
    expect((await getNotebookStore().get(WS, id))?.name).toBe("Beta");
    expect(await files()).toEqual({ "notebooks/beta.deepnote": id });
  });

  it("a rename that lost to a write made elsewhere answers 409 and changes nothing", async () => {
    const id = await seed("Draft");
    // Another instance writes the notebook between this one's read and write.
    notebookRenameHooks.afterRead = async () => {
      notebookRenameHooks.afterRead = undefined;
      await getNotebookStore().update(WS, id, { name: "Elsewhere" });
    };
    await expect(rename(id, "Mine")).rejects.toMatchObject({ status: 409 });
    expect((await getNotebookStore().get(WS, id))?.name).toBe("Elsewhere");
    expect(await files()).toEqual({ "notebooks/draft.deepnote": id });
  });

  it("refuses a name that is no name, and a caller who may not write", async () => {
    const id = await seed("Mine", "private");
    for (const bad of ["", "   ", "two\nlines", "x".repeat(201)]) {
      await expect(rename(id, bad), JSON.stringify(bad)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(
      renameNotebook({
        workspaceId: WS,
        notebookId: id,
        name: "Theirs",
        actorUserId: "u2",
        role: "member",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await NotebookIndex.findOne({ notebookId: id }))?.name).toBe(
      "Mine",
    );
  });
});

describe("a rename against a delete", () => {
  /** Deleted means: no row, no document, and no file carrying the id. */
  async function expectGone(id: string): Promise<void> {
    expect(await NotebookIndex.findOne({ notebookId: id })).toBeNull();
    expect(await getNotebookStore().get(WS, id)).toBeNull();
    expect(Object.values(await files())).not.toContain(id);
  }
  /** What `DELETE /notebooks/:id` does. */
  async function remove(id: string): Promise<void> {
    await getNotebookStore().remove(WS, id);
    await removeNotebookIndexAndFile(WS, id, "u1");
  }

  it("a delete arriving while a rename is moving the file removes the moved file", async () => {
    const id = await seed("Draft");
    const moving = hold(notebookCheckpointHooks, "beforeCommit");
    const renaming = rename(id, "Final").then(
      () => "renamed",
      (error: { status?: number }) => error.status,
    );
    await moving.reached;

    const deleting = remove(id);
    moving.release();
    await deleting;

    // Whichever the rename saw, it never reports a live notebook that is
    // not there: renamed just before the delete, or not found.
    expect(["renamed", 404]).toContain(await renaming);
    await expectGone(id);
    expect(await files()).toEqual({});
  });

  it("a rename held after its read, a delete completing meanwhile: not found, nothing left", async () => {
    const id = await seed("Draft");
    const reading = hold(notebookRenameHooks, "afterRead");
    const renaming = rename(id, "Final");
    await reading.reached;

    await remove(id);

    reading.release();
    await expect(renaming).rejects.toMatchObject({ status: 404 });
    await expectGone(id);
    expect(await files()).toEqual({});
  });

  it("a checkpoint queued behind a delete writes nothing", async () => {
    const id = await seed("Draft");
    await getNotebookStore().update(WS, id, { name: "Final" });
    await NotebookIndex.updateOne(
      { notebookId: id },
      { $set: { name: "Final" } },
    );
    await Promise.all([
      removeNotebookIndexAndFile(WS, id, "u1"),
      checkpointNotebook(WS, id, "u1"),
    ]);
    expect(await files()).toEqual({});
  });
});

describe("rename_object kind notebook", () => {
  it("resolves by id, path, or a name one readable notebook has", async () => {
    const id = await seed("Report");
    const secret = await seed("Secret", "private");
    for (const ref of [id, "notebooks/report.deepnote", "Report"]) {
      expect(await resolveObjectRef(owner, "notebook", ref), ref).toMatchObject(
        {
          kind: "notebook",
          id,
          via: "current",
          current: {
            title: "Report",
            path: "notebooks/report.deepnote",
            url: `/n/${id}`,
          },
        },
      );
    }
    expect(await resolveObjectRef(other, "notebook", secret)).toBeNull();
    expect(await resolveObjectRef(other, "notebook", "Secret")).toBeNull();
    await seed("Report");
    expect(await resolveObjectRef(owner, "notebook", "Report")).toBeNull();
  });

  it("renames by `title`, refuses `slug`, and reports the service's refusals", async () => {
    const id = await seed("Report");
    const result = await renameObject(owner, "notebook", {
      ref: id,
      title: "Q3 report",
    });
    expect(result).toMatchObject({
      kind: "notebook",
      id,
      before: { title: "Report", path: "notebooks/report.deepnote" },
      after: {
        title: "Q3 report",
        path: "notebooks/q3-report.deepnote",
        url: `/n/${id}`,
      },
      aliasesAdded: [],
      warnings: [],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    await expect(
      renameObject(owner, "notebook", { ref: id, slug: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(owner, "notebook", { ref: "nope", title: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    const mine = await seed("Mine", "private");
    await expect(
      renameObject(other, "notebook", { ref: mine, title: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    const again = await renameObject(owner, "notebook", {
      ref: id,
      title: "Q3 report",
    });
    expect(again.warnings.join(" ")).toMatch(/Nothing to change/);
  });
});
