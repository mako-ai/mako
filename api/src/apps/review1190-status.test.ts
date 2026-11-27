/**
 * Review of PR #1190: deployProgress and lastDeployError on PGlite.
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
import { Types } from "mongoose";
import {
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

vi.mock("../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn(() => ({})),
    send: vi.fn(async () => {
      throw new Error("inngest unreachable");
    }),
  },
}));

import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../repositories/apps-metadata";
import {
  describeDeployProgress,
  isDeployInFlight,
  markDeployStage,
} from "./deploy-progress";
import { recordDeployFailure, setPublishedSha } from "./deployment.service";
import { requestAppDeploys } from "../inngest/functions/apps-deploy";

let pgh: PgTestDb;
const SHA_OLD = "a".repeat(40);
const SHA_MID = "b".repeat(40);
const SHA_NEW = "c".repeat(40);
const WS = new Types.ObjectId().toString();

beforeAll(async () => {
  pgh = await setupPgTestDb();
}, 120_000);
afterAll(async () => {
  await pgh?.close();
});

let id: string;
let project: ReturnType<typeof toAppProjectCompat>;
const row = async () => {
  const record = await appsMetadataRepo.findProjectById(id, WS);
  if (!record) throw new Error("Missing app fixture");
  return record;
};

beforeEach(async () => {
  await pgh.reset();
  await ensureTestWorkspace(pgh.db, { id: WS });
  id = new Types.ObjectId().toString();
  project = toAppProjectCompat(
    await appsMetadataRepo.createProject({
      id,
      workspaceId: WS,
      title: "Review app",
      slug: `s${id}`,
      publishedSha: SHA_OLD,
    }),
  );
});

describe("a dead record and app_publish", () => {
  it("DEFECT: a failed event send must not leave a row that refuses app_publish", async () => {
    await expect(
      requestAppDeploys(WS, [id], SHA_NEW, "manual"),
    ).rejects.toThrow("inngest unreachable");
    // Nothing is queued anywhere, so the retry must be allowed.
    const after = await row();
    expect(isDeployInFlight(after.deployProgress, SHA_NEW)).toBe(false);
  });

  it("HELD: a dead record stops refusing once the stall threshold passes", async () => {
    await markDeployStage(project, SHA_NEW, "bindings");
    const after = await row();
    expect(isDeployInFlight(after.deployProgress, SHA_NEW)).toBe(true);
    const later = new Date(Date.now() + 20 * 60_000 + 1);
    expect(isDeployInFlight(after.deployProgress, SHA_NEW, later)).toBe(false);
  });
});

describe("lastDeployError", () => {
  it("DEFECT: a zombie of an older commit must not erase the newer commit's failure", async () => {
    await recordDeployFailure(project, SHA_NEW, "bindings", "smp0 401");
    expect((await row()).lastDeployError?.sha).toBe(SHA_NEW);

    await setPublishedSha(project, SHA_MID); // the zombie lands

    expect((await row()).lastDeployError?.sha).toBe(SHA_NEW);
  });

  it("DEFECT: a zombie of an older commit must not record a failure over a newer live commit", async () => {
    await setPublishedSha(project, SHA_NEW);
    await recordDeployFailure(project, SHA_MID, "bindings", "zombie died");
    // The app is up to date; nothing about it failed.
    expect((await row()).lastDeployError ?? null).toBeNull();
  });
});

describe("deployProgress with several walks", () => {
  it("DEFECT: a dead record of an older sha must not show as a deploy after a newer sha went live", async () => {
    await markDeployStage(project, SHA_MID, "bindings");
    await setPublishedSha(project, SHA_NEW); // via another path, e.g. the Publish route
    const after = await row();
    const later = new Date(Date.now() + 24 * 3_600_000);
    expect(
      describeDeployProgress(after.deployProgress, SHA_NEW, later),
    ).toBeNull();
  });
});
