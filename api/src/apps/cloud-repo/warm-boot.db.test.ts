/**
 * Which workspaces the boot warm clones: those with an apps sandbox touched
 * or an app opened in the last 24 h, most recent first, capped.
 *
 * Run: tsx src/apps/cloud-repo/warm-boot.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { AppUsageDaily, AppWorktree } from "../../database/workspace-schema";
import { hotWorkspaceIds } from "./warm-boot";

const HOUR = 60 * 60 * 1000;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const now = Date.now();
    const [sandbox, viewer, both, stale] = Array.from(
      { length: 4 },
      () => new Types.ObjectId(),
    );
    // Worktrees: timestamps are set by mongoose, so write them raw.
    await AppWorktree.collection.insertMany([
      {
        workspaceId: sandbox,
        userId: "u1",
        branch: "main",
        updatedAt: new Date(now - 2 * HOUR),
      },
      {
        workspaceId: both,
        userId: "u2",
        branch: "main",
        updatedAt: new Date(now - 10 * HOUR),
      },
      {
        workspaceId: stale,
        userId: "u3",
        branch: "main",
        updatedAt: new Date(now - 30 * HOUR),
      },
    ]);
    const usage = (ws: Types.ObjectId, hoursAgo: number, appId = "a") => ({
      workspaceId: ws,
      appId,
      userId: "u",
      day: "2026-11-16",
      firstAt: new Date(now - hoursAgo * HOUR),
      lastAt: new Date(now - hoursAgo * HOUR),
    });
    await AppUsageDaily.create([
      usage(viewer, 5),
      usage(both, 1),
      usage(stale, 48, "b"),
    ]);

    assert.deepEqual(await hotWorkspaceIds(now), [
      String(both), // 1 h (its app open beats its 10 h-old sandbox)
      String(sandbox), // 2 h
      String(viewer), // 5 h
    ]);
    assert.deepEqual(await hotWorkspaceIds(now, 24 * HOUR, 2), [
      String(both),
      String(sandbox),
    ]);
    console.info("boot repo warm hot-workspace tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
