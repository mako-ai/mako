/**
 * Draft build reuse + failure backoff (binding-draft-cache.ts), against
 * mongodb-memory-server and the filesystem artifact store. What these pin:
 *
 *   - the hash covers everything that ran, including dev-relation freshness;
 *   - each build has its own object key (concurrent builds never clobber or
 *     delete each other's), the newest unexpired build answers;
 *   - a valid build is served before the failure backoff applies, and a
 *     failure never discards it; a success ends the streak;
 *   - failure rows expire and are pruned; expired builds lose exactly their
 *     own object.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DRAFT_TTL_MS,
  FAILURE_RETENTION_MS,
  draftHash,
  forgetDraftBuild,
  lookupDraft,
  recordDraftBuilt,
  recordDraftFailed,
} from "./binding-draft-cache";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const PROJECT = new Types.ObjectId().toString();
const rows = () => mongoose.connection.collection("app_binding_drafts");

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
  await rows().deleteMany({});
});

async function localParquet(contents = "PAR1") {
  const file = path.join(
    tmpRoot,
    `built-${Date.now()}-${Math.random()}.parquet`,
  );
  await fs.writeFile(file, contents);
  return file;
}

function keep(hash: string, now: Date, name = "leads") {
  return localParquet().then(filePath =>
    recordDraftBuilt({
      projectId: PROJECT,
      name,
      hash,
      filePath,
      rowCount: 3,
      byteSize: 4,
      now,
    }),
  );
}

describe("draftHash", () => {
  it("changes with the connection, database, rendered SQL and dev freshness", () => {
    const base = {
      connectionId: "c1",
      renderedCode: "select 1 from dbt_joan.x",
    };
    const h = draftHash(base);
    expect(draftHash({ ...base })).toBe(h);
    expect(draftHash({ ...base, devModifiedAt: null })).toBe(h);
    expect(draftHash({ ...base, connectionId: "c2" })).not.toBe(h);
    expect(draftHash({ ...base, databaseName: "db" })).not.toBe(h);
    expect(
      draftHash({ ...base, renderedCode: "select 1 from dbt_prod.x" }),
    ).not.toBe(h);
    // A `dbt run` into the dev schema moves the freshness signal.
    expect(draftHash({ ...base, devModifiedAt: 1759000000000 })).not.toBe(
      draftHash({ ...base, devModifiedAt: 1759000999000 }),
    );
  });
});

describe("draft reuse", () => {
  it("serves the newest kept build within the TTL and not after", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select 1" });
    const now = new Date("2026-09-28T10:00:00Z");
    expect(await lookupDraft(PROJECT, hash, now)).toEqual({ kind: "miss" });

    const file = await localParquet("PAR1-draft");
    const key = await recordDraftBuilt({
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
    expect(key.startsWith(`apps/drafts/${PROJECT}/${hash}-`)).toBe(true);
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

  it("gives concurrent builds of one draft separate objects", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select 2" });
    const now = new Date();
    const [a, b] = await Promise.all([keep(hash, now), keep(hash, now)]);
    expect(a).not.toBe(b);
    const store = getDashboardArtifactStore();
    expect(await store.exists(a)).toBe(true);
    expect(await store.exists(b)).toBe(true);
  });

  it("forgets a build whose object is gone, so the next lookup is a miss", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select 3" });
    const now = new Date();
    const key = await keep(hash, now);
    await getDashboardArtifactStore().delete(key);
    await forgetDraftBuild(PROJECT, key);
    expect(await lookupDraft(PROJECT, hash, now)).toEqual({ kind: "miss" });
  });

  it("deletes exactly the expired build's object when the project keeps a new one", async () => {
    const t0 = new Date("2026-09-28T10:00:00Z");
    const hash = draftHash({ connectionId: "c1", renderedCode: "select old" });
    const old = await keep(hash, t0, "a");
    const later = new Date(t0.getTime() + DRAFT_TTL_MS + 1000);
    const fresh = await keep(hash, later, "a");
    const store = getDashboardArtifactStore();
    expect(await store.exists(old)).toBe(false);
    expect(await store.exists(fresh)).toBe(true);
    expect(await rows().countDocuments({ key: old })).toBe(0);
    expect(await lookupDraft(PROJECT, hash, later)).toMatchObject({
      kind: "hit",
      key: fresh,
    });
  });
});

describe("failure backoff", () => {
  it("refuses a failing draft for a doubling window; success ends the streak", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select nope" });
    const t0 = new Date("2026-09-28T10:00:00Z");
    const fail = (error: string, now: Date) =>
      recordDraftFailed({
        projectId: PROJECT,
        name: "leads",
        hash,
        error,
        now,
      });
    expect(await fail("Unrecognized name: nope", t0)).toBe(60_000);
    expect(await lookupDraft(PROJECT, hash, t0)).toEqual({
      kind: "cooling",
      retryAfterMs: 60_000,
      failures: 1,
      error: "Unrecognized name: nope",
    });
    const t1 = new Date(t0.getTime() + 61_000);
    expect(await lookupDraft(PROJECT, hash, t1)).toEqual({ kind: "miss" });
    expect(await fail("again", t1)).toBe(120_000);

    await keep(hash, new Date(t1.getTime() + 121_000));
    expect(await fail("flaky", new Date(t1.getTime() + 122_000))).toBe(60_000);
  });

  it("serves a valid build before applying the backoff; a failure does not discard it", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select ok" });
    const t0 = new Date();
    const key = await keep(hash, t0);
    await recordDraftFailed({
      projectId: PROJECT,
      name: "leads",
      hash,
      error: "transient",
      now: t0,
    });
    expect(await lookupDraft(PROJECT, hash, t0)).toMatchObject({
      kind: "hit",
      key,
    });
  });

  it("failure rows expire after their window and are pruned", async () => {
    const hash = draftHash({ connectionId: "c1", renderedCode: "select bad" });
    const t0 = new Date("2026-09-28T10:00:00Z");
    await recordDraftFailed({
      projectId: PROJECT,
      name: "leads",
      hash,
      error: "bad",
      now: t0,
    });
    const row = await rows().findOne({ hash, kind: "failure" });
    expect(row?.expiresAt).toEqual(
      new Date(t0.getTime() + 60_000 + FAILURE_RETENTION_MS),
    );
    // Any later keep in the project prunes it once expired.
    await keep(
      draftHash({ connectionId: "c1", renderedCode: "select other" }),
      new Date(t0.getTime() + 60_000 + FAILURE_RETENTION_MS + 1),
    );
    expect(await rows().countDocuments({ hash, kind: "failure" })).toBe(0);
  });
});
