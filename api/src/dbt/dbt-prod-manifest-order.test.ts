/**
 * Two races in the dbt runner, closed.
 *
 *  1. Prod manifest promotion is compare-and-set on commit order. Runs pin
 *     their commit at trigger time and Inngest does not finish them in
 *     order, so an older commit's run finishing last must not overwrite a
 *     newer manifest (real Mongoose against mongodb-memory-server).
 *  2. The packages cache is content-addressed by the declarations hash, so
 *     concurrent writers can never pair one tarball with another's hash.
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

vi.mock(
  import("../repositories/dbt"),
  () => import("../test-support/dbt-mongo"),
);
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

const commitTimes = new Map<string, Date>();
vi.mock("./dbt-working-tree.service", async importOriginal => ({
  ...(await importOriginal<typeof import("./dbt-working-tree.service")>()),
  commitTimeOf: vi.fn(
    async (_project: unknown, sha: string) => commitTimes.get(sha) ?? null,
  ),
}));

// An in-memory artifact store whose puts finish in whatever order the test
// releases them, to interleave two writers.
const objects = new Map<string, Buffer>();
let putGate: ((key: string) => Promise<void>) | null = null;
vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    putBuffer: async (buffer: Buffer, key: string) => {
      if (putGate) await putGate(key);
      objects.set(key, Buffer.from(buffer));
    },
    openReadStream: async (key: string) => {
      const value = objects.get(key);
      if (!value) return null;
      const { Readable } = await import("stream");
      return Readable.from([value]);
    },
  }),
}));

import { DbtProject } from "../database/workspace-schema";
import { prodManifestOrderKey, promoteProdManifest } from "./dbt-run.service";
import {
  computePackagesHash,
  loadDbtCaches,
  savePackagesCache,
} from "./dbt-cache.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await DbtProject.deleteMany({});
  commitTimes.clear();
  objects.clear();
  putGate = null;
});

async function createProject(extra: Record<string, unknown> = {}) {
  const project = await DbtProject.create({
    workspaceId: WS,
    name: "analytics",
    createdBy: "u1",
    ...extra,
  });
  return project._id;
}

async function stored(projectId: Types.ObjectId) {
  return DbtProject.findById(projectId)
    .select(
      "lastProdManifestKey lastProdManifestCommittedAt lastProdManifestSha",
    )
    .lean();
}

const OLD = new Date("2026-11-19T10:00:00Z");
const NEW = new Date("2026-11-19T10:05:00Z");

describe("promoteProdManifest", () => {
  it("an older commit's run finishing after a newer one keeps the newer manifest", async () => {
    const projectId = await createProject();
    // The newer commit's run finishes first.
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/new.json",
        committedAt: NEW,
        sourceSha: "b".repeat(40),
      }),
    ).toBe(true);
    // The older commit's run finishes last.
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/old.json",
        committedAt: OLD,
        sourceSha: "a".repeat(40),
      }),
    ).toBe(false);
    const doc = await stored(projectId);
    expect(doc?.lastProdManifestKey).toBe("manifests/new.json");
    expect(doc?.lastProdManifestCommittedAt).toEqual(NEW);
    expect(doc?.lastProdManifestSha).toBe("b".repeat(40));
  });

  it("a newer commit's run replaces an older manifest", async () => {
    const projectId = await createProject();
    await promoteProdManifest({
      projectId,
      manifestKey: "manifests/old.json",
      committedAt: OLD,
      sourceSha: "a".repeat(40),
    });
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/new.json",
        committedAt: NEW,
        sourceSha: "b".repeat(40),
      }),
    ).toBe(true);
    expect((await stored(projectId))?.lastProdManifestKey).toBe(
      "manifests/new.json",
    );
  });

  it("a rebuild of the same commit refreshes the manifest", async () => {
    const projectId = await createProject();
    await promoteProdManifest({
      projectId,
      manifestKey: "manifests/first.json",
      committedAt: NEW,
      sourceSha: "b".repeat(40),
    });
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/rebuild.json",
        committedAt: NEW,
        sourceSha: "b".repeat(40),
      }),
    ).toBe(true);
    expect((await stored(projectId))?.lastProdManifestKey).toBe(
      "manifests/rebuild.json",
    );
  });

  it("a project promoted before the order key existed takes the next manifest", async () => {
    // An existing doc: a manifest key and no order key.
    const projectId = await createProject({
      lastProdManifestKey: "manifests/legacy.json",
    });
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/old.json",
        committedAt: OLD,
      }),
    ).toBe(true);
    const doc = await stored(projectId);
    expect(doc?.lastProdManifestKey).toBe("manifests/old.json");
    expect(doc?.lastProdManifestCommittedAt).toEqual(OLD);
    expect(doc?.lastProdManifestSha).toBeUndefined();
  });

  it("a project with no manifest at all promotes", async () => {
    const projectId = await createProject();
    expect(
      await promoteProdManifest({
        projectId,
        manifestKey: "manifests/first.json",
        committedAt: OLD,
      }),
    ).toBe(true);
    expect((await stored(projectId))?.lastProdManifestKey).toBe(
      "manifests/first.json",
    );
  });
});

describe("prodManifestOrderKey", () => {
  it("is the pinned commit's committer time, not when the run was created", async () => {
    commitTimes.set("a".repeat(40), OLD);
    const key = await prodManifestOrderKey({
      workspaceId: WS,
      sourceSha: "a".repeat(40),
      createdAt: NEW,
    });
    expect(key).toEqual(OLD);
  });

  it("falls back to the run's creation time without a readable commit", async () => {
    expect(
      await prodManifestOrderKey({ workspaceId: WS, createdAt: NEW }),
    ).toEqual(NEW);
    expect(
      await prodManifestOrderKey({
        workspaceId: WS,
        sourceSha: "c".repeat(40),
        createdAt: OLD,
      }),
    ).toEqual(OLD);
  });
});

function hashOf(files: Array<{ path: string; content: string }>): string {
  const hash = computePackagesHash(files);
  if (!hash) throw new Error("expected declared packages");
  return hash;
}

describe("packages cache", () => {
  const scope = { workspaceId: "ws", projectId: "p", environment: "prod" };
  const filesA = [
    {
      path: "packages.yml",
      content:
        "packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.1.0\n",
    },
  ];
  const filesB = [
    {
      path: "packages.yml",
      content:
        "packages:\n  - package: dbt-labs/dbt_utils\n    version: 1.3.0\n",
    },
  ];

  it("never returns a tarball installed from other declarations, whatever order concurrent writes land in", async () => {
    const hashA = hashOf(filesA);
    const hashB = hashOf(filesB);
    const tgzA = Buffer.from("tgz installed from A");
    const tgzB = Buffer.from("tgz installed from B");

    // Interleave the two writers: B's put lands first, A's last.
    const releases: Array<() => void> = [];
    putGate = () => new Promise<void>(resolve => releases.push(resolve));
    const writeA = savePackagesCache(scope, tgzA, hashA);
    const writeB = savePackagesCache(scope, tgzB, hashB);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    releases[0]();
    await Promise.all([writeA, writeB]);
    putGate = null;

    const loadedA = await loadDbtCaches(scope, hashA);
    expect(loadedA.packagesFresh).toBe(true);
    expect(loadedA.packages?.toString()).toBe("tgz installed from A");
    const loadedB = await loadDbtCaches(scope, hashB);
    expect(loadedB.packagesFresh).toBe(true);
    expect(loadedB.packages?.toString()).toBe("tgz installed from B");
  });

  it("is a miss for declarations nothing was installed from", async () => {
    await savePackagesCache(
      scope,
      Buffer.from("tgz installed from A"),
      hashOf(filesA),
    );
    const loaded = await loadDbtCaches(scope, computePackagesHash(filesB));
    expect(loaded.packagesFresh).toBe(false);
    expect(loaded.packages).toBeUndefined();
  });

  it("is a miss when the project declares no packages", async () => {
    const loaded = await loadDbtCaches(scope, null);
    expect(loaded.packagesFresh).toBe(false);
  });
});
