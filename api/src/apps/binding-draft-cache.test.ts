/**
 * Draft build reuse + failure backoff (binding-draft-cache.ts), against
 * mongodb-memory-server and the filesystem artifact store. What these pin:
 *
 *   - the key covers everything that ran (connection, database, rendered SQL);
 *   - a kept draft is served until DRAFT_TTL_MS, under apps/drafts/<project>/;
 *   - failures back off 1m, 2m, … and a success resets the streak;
 *   - expired drafts of a project are deleted (object + row) on the next store.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DRAFT_TTL_MS,
  draftArtifactKey,
  draftHash,
  lookupDraft,
  recordDraftBuilt,
  recordDraftFailed,
} from "./binding-draft-cache";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const PROJECT = new Types.ObjectId().toString();

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "draft-cache-test-"));
  process.env.DASHBOARD_ARTIFACT_DIR = path.join(tmpRoot, "artifacts");
  delete process.env.DASHBOARD_ARTIFACT_STORE;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await mongoose.connection.collection("app_binding_drafts").deleteMany({});
});

async function localParquet(contents = "PAR1") {
  const file = path.join(
    tmpRoot,
    `built-${Date.now()}-${Math.random()}.parquet`,
  );
  await fs.writeFile(file, contents);
  return file;
}

describe("draftHash", () => {
  it("changes with the connection, the database and the rendered SQL", () => {
    const base = {
      connectionId: "c1",
      renderedCode: "select 1 from dbt_joan.x",
    };
    const h = draftHash(base);
    expect(draftHash({ ...base })).toBe(h);
    expect(draftHash({ ...base, connectionId: "c2" })).not.toBe(h);
    expect(draftHash({ ...base, databaseName: "db" })).not.toBe(h);
    // A defer choice flipping (dev → prod schema) is a different draft.
    expect(
      draftHash({ ...base, renderedCode: "select 1 from dbt_prod.x" }),
    ).not.toBe(h);
  });
});

describe("draft reuse", () => {
  it("serves a kept draft within the TTL and not after", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select 1" });
    const now = new Date("2026-09-28T10:00:00Z");
    expect(await lookupDraft(PROJECT, hash, now)).toEqual({ kind: "miss" });

    const file = await localParquet("PAR1-draft");
    await recordDraftBuilt({
      projectId: PROJECT,
      name: "leads",
      hash,
      filePath: file,
      rowCount: 3,
      byteSize: 10,
      now,
    });
    // The caller still owns (and streams) the local file.
    await expect(fs.access(file)).resolves.toBeUndefined();

    const key = draftArtifactKey(PROJECT, hash);
    expect(key.startsWith(`apps/drafts/${PROJECT}/`)).toBe(true);
    expect(await getDashboardArtifactStore().exists(key)).toBe(true);
    expect(
      await lookupDraft(PROJECT, hash, new Date(now.getTime() + 60_000)),
    ).toEqual({ kind: "hit", key, rowCount: 3, builtAt: now });
    expect(
      await lookupDraft(
        PROJECT,
        hash,
        new Date(now.getTime() + DRAFT_TTL_MS + 1),
      ),
    ).toEqual({ kind: "miss" });
  });

  it("deletes a project's expired drafts when it keeps a new one", async () => {
    const t0 = new Date("2026-09-28T10:00:00Z");
    const old = draftHash({ connectionId: "c1", renderedCode: "select old" });
    await recordDraftBuilt({
      projectId: PROJECT,
      name: "a",
      hash: old,
      filePath: await localParquet(),
      rowCount: 1,
      byteSize: 4,
      now: t0,
    });
    const later = new Date(t0.getTime() + DRAFT_TTL_MS + 1000);
    await recordDraftBuilt({
      projectId: PROJECT,
      name: "b",
      hash: draftHash({ connectionId: "c1", renderedCode: "select new" }),
      filePath: await localParquet(),
      rowCount: 1,
      byteSize: 4,
      now: later,
    });
    expect(
      await getDashboardArtifactStore().exists(draftArtifactKey(PROJECT, old)),
    ).toBe(false);
    expect(
      await mongoose.connection
        .collection("app_binding_drafts")
        .countDocuments({ hash: old }),
    ).toBe(0);
  });
});

describe("failure backoff", () => {
  it("refuses a failing draft for a doubling window; success resets it", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select nope" });
    const t0 = new Date("2026-09-28T10:00:00Z");
    expect(
      await recordDraftFailed({
        projectId: PROJECT,
        name: "leads",
        hash,
        error: "Unrecognized name: nope",
        now: t0,
      }),
    ).toBe(60_000);
    expect(await lookupDraft(PROJECT, hash, t0)).toEqual({
      kind: "cooling",
      retryAfterMs: 60_000,
      failures: 1,
      error: "Unrecognized name: nope",
    });
    const t1 = new Date(t0.getTime() + 61_000);
    expect(await lookupDraft(PROJECT, hash, t1)).toEqual({ kind: "miss" });
    expect(
      await recordDraftFailed({
        projectId: PROJECT,
        name: "leads",
        hash,
        error: "again",
        now: t1,
      }),
    ).toBe(120_000);

    await recordDraftBuilt({
      projectId: PROJECT,
      name: "leads",
      hash,
      filePath: await localParquet(),
      rowCount: 0,
      byteSize: 4,
      now: new Date(t1.getTime() + 121_000),
    });
    expect(
      await recordDraftFailed({
        projectId: PROJECT,
        name: "leads",
        hash,
        error: "flaky",
        now: new Date(t1.getTime() + 122_000),
      }),
    ).toBe(60_000);
  });
});
