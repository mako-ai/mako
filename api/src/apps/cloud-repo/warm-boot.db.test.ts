/**
 * Which workspaces the boot warm clones: those with an apps sandbox touched
 * or an app opened in the last 24 h, most recent first, capped.
 *
 * Run: tsx src/apps/cloud-repo/warm-boot.db.test.ts
 */
import assert from "node:assert/strict";
import { generateUuidv7 } from "../../database/pg/id-codec";
import { appUsageDaily, appWorktrees } from "../../database/pg/schema";
import {
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../../test-support/pg-test";
import { hotWorkspaceIds } from "./warm-boot";

const HOUR = 60 * 60 * 1000;

async function main() {
  const pgh = await setupPgTestDb();
  try {
    const now = Date.now();
    const [sandbox, viewer, both, stale] = await Promise.all(
      Array.from({ length: 4 }, () => ensureTestWorkspace(pgh.db)),
    );
    await pgh.db.insert(appWorktrees).values([
      {
        workspaceId: sandbox.uuid,
        actorId: "u1",
        branch: "main",
        updatedAt: new Date(now - 2 * HOUR),
      },
      {
        workspaceId: both.uuid,
        actorId: "u2",
        branch: "main",
        updatedAt: new Date(now - 10 * HOUR),
      },
      {
        workspaceId: stale.uuid,
        actorId: "u3",
        branch: "main",
        updatedAt: new Date(now - 30 * HOUR),
      },
    ]);
    const viewerUser = await ensureTestUser(pgh.db);
    const app = generateUuidv7();
    const usage = (workspaceId: string, hoursAgo: number, appId = app) => ({
      workspaceId,
      appId,
      userId: viewerUser.id,
      visitorKey: `u:${viewerUser.id}`,
      day: "2026-11-16",
      firstAt: new Date(now - hoursAgo * HOUR),
      lastAt: new Date(now - hoursAgo * HOUR),
    });
    await pgh.db
      .insert(appUsageDaily)
      .values([
        usage(viewer.uuid, 5),
        usage(both.uuid, 1),
        usage(stale.uuid, 48, generateUuidv7()),
      ]);

    assert.deepEqual(await hotWorkspaceIds(now), [
      both.id, // 1 h (its app open beats its 10 h-old sandbox)
      sandbox.id, // 2 h
      viewer.id, // 5 h
    ]);
    assert.deepEqual(await hotWorkspaceIds(now, 24 * HOUR, 2), [
      both.id,
      sandbox.id,
    ]);
    console.info("boot repo warm hot-workspace tests passed");
  } finally {
    await pgh.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
