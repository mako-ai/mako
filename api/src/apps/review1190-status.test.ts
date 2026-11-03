/**
 * Review of PR #1190: deployProgress and lastDeployError on real Mongo.
 */
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

vi.mock("../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(() => ({})),
    send: vi.fn(async () => {
      throw new Error("inngest unreachable");
    }),
  },
}));

import { AppProject, type IAppProject } from "../database/workspace-schema";
import {
  describeDeployProgress,
  isDeployInFlight,
  markDeployStage,
} from "./deploy-progress";
import { recordDeployFailure, setPublishedSha } from "./deployment.service";
import { requestAppDeploys } from "../inngest/functions/apps-deploy";

let mongo: MongoMemoryServer;
const SHA_OLD = "a".repeat(40);
const SHA_MID = "b".repeat(40);
const SHA_NEW = "c".repeat(40);
const WS = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

let id: Types.ObjectId;
const row = async () => (await AppProject.findById(id).lean()) as IAppProject;
const ref = () => ({ _id: id, workspaceId: WS }) as unknown as IAppProject;

beforeEach(async () => {
  id = new Types.ObjectId();
  await AppProject.collection.insertOne({
    _id: id,
    workspaceId: WS,
    slug: `s${id.toString()}`,
    publishedSha: SHA_OLD,
  });
});

describe("a dead record and app_publish", () => {
  it("DEFECT: a failed event send must not leave a row that refuses app_publish", async () => {
    await expect(
      requestAppDeploys(WS.toString(), [id.toString()], SHA_NEW, "manual"),
    ).rejects.toThrow("inngest unreachable");
    // Nothing is queued anywhere, so the retry must be allowed.
    const after = await row();
    expect(isDeployInFlight(after.deployProgress, SHA_NEW)).toBe(false);
  });

  it("HELD: a dead record stops refusing once the stall threshold passes", async () => {
    await markDeployStage(ref(), SHA_NEW, "bindings");
    const after = await row();
    expect(isDeployInFlight(after.deployProgress, SHA_NEW)).toBe(true);
    const later = new Date(Date.now() + 20 * 60_000 + 1);
    expect(isDeployInFlight(after.deployProgress, SHA_NEW, later)).toBe(false);
  });
});

describe("lastDeployError", () => {
  it("DEFECT: a zombie of an older commit must not erase the newer commit's failure", async () => {
    await recordDeployFailure(ref(), SHA_NEW, "bindings", "smp0 401");
    expect((await row()).lastDeployError?.sha).toBe(SHA_NEW);

    await setPublishedSha(ref(), SHA_MID); // the zombie lands

    expect((await row()).lastDeployError?.sha).toBe(SHA_NEW);
  });

  it("DEFECT: a zombie of an older commit must not record a failure over a newer live commit", async () => {
    await setPublishedSha(ref(), SHA_NEW);
    await recordDeployFailure(ref(), SHA_MID, "bindings", "zombie died");
    // The app is up to date; nothing about it failed.
    expect((await row()).lastDeployError ?? null).toBeNull();
  });
});

describe("deployProgress with several walks", () => {
  it("DEFECT: a dead record of an older sha must not show as a deploy after a newer sha went live", async () => {
    await markDeployStage(ref(), SHA_MID, "bindings");
    await setPublishedSha(ref(), SHA_NEW); // via another path, e.g. the Publish route
    const after = await row();
    const later = new Date(Date.now() + 24 * 3_600_000);
    expect(
      describeDeployProgress(after.deployProgress, SHA_NEW, later),
    ).toBeNull();
  });
});
