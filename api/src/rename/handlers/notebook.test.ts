/**
 * The notebook rename handler: real bare repo, filesystem notebook store,
 * mongodb-memory-server for the index (the notebook-git.service.test rig).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { NotebookIndex } from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  log as repoLog,
  readBlob,
  repoDirFor,
} from "../../apps/repository.service";
import { getNotebookStore } from "../../notebooks/store";
import {
  parseNotebookFile,
  serializeNotebookFile,
} from "../../notebooks/deepnote-file";
import { checkpointNotebook } from "../../notebooks/notebook-git.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rename-notebook-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.NOTEBOOK_WORKDIR = path.join(tmpRoot, "notebooks");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.NOTEBOOK_GCS_BUCKET;
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await unbindTestWorkspaceRepo(WS);
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

async function seedNotebook(
  name: string,
  access: "private" | "workspace",
  ownerId = "u1",
) {
  const doc = await getNotebookStore().create(WS, { name });
  await getNotebookStore().update(WS, doc.id, {
    blocks: [{ id: "b1", type: "markdown", source: `# ${name}` }],
  });
  await NotebookIndex.create({
    workspaceId: new Types.ObjectId(WS),
    notebookId: doc.id,
    name,
    ownerId,
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

const u1 = { workspaceId: WS, userId: "u1", role: "member" };
const u2 = { workspaceId: WS, userId: "u2", role: "member" };

describe("notebook rename", () => {
  it("resolves by id, path and unique name; never leaks a private notebook", async () => {
    const id = await seedNotebook("Churn study", "private");
    await checkpointNotebook(WS, id, "u1");
    for (const ref of [
      id,
      `users/u1/notebooks/churn-study.deepnote`,
      "Churn study",
    ]) {
      expect(await resolveObjectRef(u1, "notebook", ref), ref).toMatchObject({
        kind: "notebook",
        id,
        via: "current",
        current: {
          title: "Churn study",
          path: "users/u1/notebooks/churn-study.deepnote",
          url: `/n/${id}`,
        },
      });
    }
    expect(await resolveObjectRef(u2, "notebook", id)).toBeNull();
  });

  it("title renames the store doc + index and moves the file in ONE commit; id unchanged", async () => {
    const id = await seedNotebook("Before", "workspace");
    await checkpointNotebook(WS, id, "u1");
    const commits = (await repoLog(repoDirFor(WS), MAIN, 50)).length;
    const result = await renameObject(u1, "notebook", {
      ref: id,
      title: "After",
    });
    expect(result).toMatchObject({
      kind: "notebook",
      id,
      before: { title: "Before", path: "notebooks/before.deepnote" },
      after: {
        title: "After",
        path: "notebooks/after.deepnote",
        url: `/n/${id}`,
      },
      aliasesAdded: [],
      warnings: [],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await repoLog(repoDirFor(WS), MAIN, 50)).length).toBe(commits + 1);
    expect(await fileAt("notebooks/after.deepnote")).toContain("name: After");
    expect(await fileAt("notebooks/before.deepnote")).toBeNull();
    expect((await getNotebookStore().get(WS, id))?.name).toBe("After");
    expect((await NotebookIndex.findOne({ notebookId: id }))?.name).toBe(
      "After",
    );
  });

  it("renaming onto the name of a laptop-made (unindexed) .deepnote takes the next free path", async () => {
    const id = await seedNotebook("Alpha", "workspace");
    await checkpointNotebook(WS, id, "u1");
    // A notebook made on a laptop, pushed, not yet indexed.
    const laptopId = "22222222-2222-4222-8222-222222222222";
    const laptop = serializeNotebookFile({
      id: laptopId,
      name: "Beta",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      blocks: [{ id: "b1", type: "markdown", source: "# laptop beta" }],
    } as never);
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "notebooks/beta.deepnote": laptop } },
      { message: "laptop" },
    );
    const result = await renameObject(u1, "notebook", {
      ref: id,
      title: "Beta",
    });
    expect(result.after.path).toBe("notebooks/beta-2.deepnote");
    expect(
      parseNotebookFile((await fileAt("notebooks/beta.deepnote"))!)?.id,
    ).toBe(laptopId);
    expect(
      parseNotebookFile((await fileAt("notebooks/beta-2.deepnote"))!)?.id,
    ).toBe(id);
    expect(await fileAt("notebooks/alpha.deepnote")).toBeNull();
  });

  it("refuses a slug, an empty title, and another member's private notebook", async () => {
    const id = await seedNotebook("Locked", "private");
    await expect(
      renameObject(u1, "notebook", { ref: id, slug: "notebooks/x.deepnote" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(u1, "notebook", { ref: id, title: "   " }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(u2, "notebook", { ref: id, title: "Stolen" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
