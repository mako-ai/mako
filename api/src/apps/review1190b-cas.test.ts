/** Second review of PR #1190: the conditional repoint on real Mongo. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { setPublishedSha } from "./deployment.service";

let mongo: MongoMemoryServer;
const [A, B, C] = ["a", "b", "c"].map(c => c.repeat(40));
const WS = new Types.ObjectId();
let id: Types.ObjectId;
const row = async () => (await AppProject.findById(id).lean()) as IAppProject;
const ref = () => ({ _id: id, workspaceId: WS }) as unknown as IAppProject;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  id = new Types.ObjectId();
  await AppProject.collection.insertOne({
    _id: id,
    workspaceId: WS,
    slug: `s${id.toString()}`,
    publishedSha: A,
  });
});

describe("conditional repoint", () => {
  it("HELD: of two racing deploys from one pointer, exactly one wins", async () => {
    const [x, y] = await Promise.all([
      setPublishedSha(ref(), B, { expected: A }),
      setPublishedSha(ref(), C, { expected: A }),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect((await row()).publishedSha).toBe(x ? B : C);
  });
  it("HELD: a first publish (expected null) matches a row with no pointer", async () => {
    await AppProject.collection.updateOne(
      { _id: id },
      { $unset: { publishedSha: 1 } },
    );
    await expect(setPublishedSha(ref(), B, { expected: null })).resolves.toBe(
      true,
    );
    expect((await row()).publishedSha).toBe(B);
  });
  it("HELD: same-commit landing twice both succeed (a retry is not a lost publish)", async () => {
    await expect(setPublishedSha(ref(), B, { expected: A })).resolves.toBe(
      true,
    );
    await expect(setPublishedSha(ref(), B, { expected: B })).resolves.toBe(
      true,
    );
  });
  it("HELD: Publish and rollback are unconditional, so they are the way out", async () => {
    await expect(setPublishedSha(ref(), C)).resolves.toBe(true);
    expect((await row()).publishedSha).toBe(C);
  });
  // Listed in the PR body. It contradicts review1190-status "a zombie of an older
  // commit must not erase the newer commit's failure": without a repo, both are
  // an unplaceable failed sha.
  it.fails(
    "OPEN: a good publish clears a failure of a commit force-pushed off main",
    async () => {
      await AppProject.collection.updateOne(
        { _id: id },
        {
          $set: {
            lastDeployError: {
              sha: "d".repeat(40),
              stage: "build",
              message: "x",
              at: new Date(),
            },
          },
        },
      );
      await setPublishedSha(ref(), B);
      expect((await row()).lastDeployError ?? null).toBeNull();
    },
  );
});
