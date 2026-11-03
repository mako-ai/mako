/**
 * Deploy progress on the app row: what app_publish_status reports between
 * "enqueued" and "live". Real Mongo for the writes; the view is pure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { AppProject } from "../database/workspace-schema";
import {
  DEPLOY_STALL_MS,
  clearDeployProgress,
  deployErrorStageFor,
  describeDeployProgress,
  markBindingProgress,
  markDeployQueued,
  markDeployStage,
} from "./deploy-progress";

let mongo: MongoMemoryServer;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await AppProject.deleteMany({});
});

async function seedApp() {
  return AppProject.create({
    workspaceId: new Types.ObjectId(),
    title: "Pipeline",
    slug: "pipeline",
  });
}

async function progressOf(id: Types.ObjectId) {
  const row = await AppProject.findById(id).lean();
  return row?.deployProgress ?? null;
}

describe("deploy progress writes", () => {
  it("walks queued → bindings (n of m) → publishing and clears when live", async () => {
    const app = await seedApp();
    const t0 = new Date("2026-10-30T10:00:00Z");
    await markDeployQueued(app._id.toString(), SHA_A, t0);
    expect(await progressOf(app._id)).toMatchObject({
      sha: SHA_A,
      stage: "queued",
    });

    const t1 = new Date("2026-10-30T10:03:00Z");
    await markDeployStage(app, SHA_A, "bindings", t1);
    await markBindingProgress(
      app,
      SHA_A,
      { total: 7, prepared: 3, current: "pipeline" },
      t1,
    );
    const mid = await progressOf(app._id);
    expect(mid).toMatchObject({
      sha: SHA_A,
      stage: "bindings",
      bindings: { total: 7, prepared: 3, current: "pipeline" },
    });
    // The record started when the deploy was requested, not at this stage.
    expect(mid?.startedAt.toISOString()).toBe(t0.toISOString());
    expect(mid?.stageStartedAt.toISOString()).toBe(t1.toISOString());

    await markDeployStage(app, SHA_A, "publishing");
    const publishing = await progressOf(app._id);
    expect(publishing?.stage).toBe("publishing");
    expect(publishing?.bindings).toBeUndefined();

    await clearDeployProgress(app, SHA_A);
    expect(await progressOf(app._id)).toBeNull();
  });

  it("an older deploy finishing a step never hides the newer one", async () => {
    const app = await seedApp();
    await markDeployQueued(app, SHA_B);
    await markDeployStage(app, SHA_A, "build");
    await markBindingProgress(app, SHA_A, { total: 1, prepared: 1 });
    await clearDeployProgress(app, SHA_A);
    expect(await progressOf(app._id)).toMatchObject({
      sha: SHA_B,
      stage: "queued",
    });
  });

  it("a deploy with no queued record (the Publish route) still shows its stage", async () => {
    const app = await seedApp();
    await markDeployStage(app, SHA_A, "build");
    expect(await progressOf(app._id)).toMatchObject({
      sha: SHA_A,
      stage: "build",
    });
  });

  it("ignores ids that are not object ids", async () => {
    await expect(markDeployQueued("sales", SHA_A)).resolves.toBeUndefined();
  });
});

describe("describeDeployProgress", () => {
  const started = new Date("2026-10-30T10:00:00Z");
  const progress = {
    sha: SHA_A,
    stage: "bindings" as const,
    startedAt: started,
    stageStartedAt: new Date("2026-10-30T10:02:00Z"),
    updatedAt: new Date("2026-10-30T10:10:00Z"),
    bindings: { total: 7, prepared: 3, current: "pipeline" },
  };

  it("names the stage, the bindings prepared and the time in stage", () => {
    const view = describeDeployProgress(
      progress,
      null,
      new Date("2026-10-30T10:14:00Z"),
    );
    expect(view?.summary).toBe(
      "bindings: 3 of 7 prepared (preparing `pipeline`), 12 min in this stage",
    );
    expect(view?.elapsedMs).toBe(14 * 60_000);
    expect(view?.stalled).toBeUndefined();
  });

  it("flags a stage with no heartbeat past its threshold", () => {
    const now = new Date(
      progress.updatedAt.getTime() + DEPLOY_STALL_MS.bindings + 60_000,
    );
    const view = describeDeployProgress(progress, null, now);
    expect(view?.stalled?.thresholdMs).toBe(DEPLOY_STALL_MS.bindings);
    expect(view?.stalled?.message).toContain('No progress in "bindings"');
  });

  it("shows nothing for a leftover record of the live commit", () => {
    expect(describeDeployProgress(progress, SHA_A)).toBeNull();
    expect(describeDeployProgress(undefined, null)).toBeNull();
  });

  it("maps a stage to the lastDeployError stage", () => {
    expect(deployErrorStageFor("bindings")).toBe("bindings");
    expect(deployErrorStageFor("publishing")).toBe("publish");
    expect(deployErrorStageFor("build")).toBe("build");
    expect(deployErrorStageFor(undefined)).toBe("build");
  });
});
