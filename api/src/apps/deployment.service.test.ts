import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../services/artifact-store.service";

const stores = vi.hoisted(() => ({
  primary: undefined as ArtifactStore | undefined,
  source: undefined as ArtifactStore | undefined,
  bindings: [] as Array<
    Pick<
      AppBinding,
      | "name"
      | "connectionId"
      | "materialization"
      | "schedule"
      | "timezone"
      | "code"
      | "sql"
    >
  >,
  skipped: [] as Array<{ path: string; error: string }>,
}));

vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => stores.primary,
  getArtifactSourceStore: () => stores.source ?? null,
}));

const refreshes = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../inngest/functions/apps-binding-refresh", () => ({
  requestBindingRefreshes: refreshes.send,
}));

vi.mock("./bindings.service", () => ({
  bindingArtifactKey: vi.fn(
    (binding: { connectionId: string; name: string }) =>
      `apps/bindings/${binding.connectionId}/${binding.name}.parquet`,
  ),
  bindingArtifactKeyByName: vi.fn(
    async () => "apps/bindings/connection/binding.parquet",
  ),
  materializeAppBinding: vi.fn(async () => ({
    rowCount: 1,
    byteSize: 10,
    materializedAt: new Date(),
  })),
  readBindingsTolerant: vi.fn(async () => ({
    bindings: stores.bindings,
    skipped: stores.skipped,
  })),
}));

vi.mock("../database/workspace-schema", () => ({
  AppProject: {
    findById: vi.fn(async () => ({ _id: "project" })),
    updateOne: vi.fn(),
  },
}));

vi.mock("./app-viewer.service", () => ({
  resolveAppViewer: vi.fn(
    async (_project: unknown, identity: { id: string; email: string }) => ({
      id: identity.id,
      email: identity.email,
      workspace: { id: "ws", name: "Acme", role: "viewer" },
      app: { id: "project", slug: "sales", role: "viewer" },
    }),
  ),
}));

vi.mock("../services/artifact-delivery.service", () => ({
  SIGNED_URL_TTL_SECONDS: 600,
  artifactDeliveryMode: vi.fn(async () => "redirect"),
  signArtifactUrl: vi.fn(
    async (
      store: { getSignedUrl: (k: string, t: number) => unknown },
      key,
    ) => ({
      url: await store.getSignedUrl(key, 600),
      expiresAt: null,
    }),
  ),
  serveParquetArtifact: vi.fn(
    async (store, key) =>
      new Response(`${store === stores.source}:${key}`, { status: 200 }),
  ),
  serveJsonArtifact: vi.fn(
    async (store, key) =>
      new Response(`json:${store === stores.source}:${key}`, { status: 200 }),
  ),
}));

vi.mock("./box", () => ({
  readBoxDir: vi.fn(async (_ctx, _source, destination: string) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${destination}/index.html`, "<html></html>");
  }),
}));

import {
  DEPLOYMENT_BINDING_INDEX,
  deployBuild,
  deploymentExists,
  deploymentKey,
  ensureDeploymentBindings,
  readDeploymentAsset,
  serveDeploymentFile,
  setPublishedSha,
} from "./deployment.service";
import {
  bindingArtifactKeyByName,
  materializeAppBinding,
  readBindingsTolerant,
  type AppBinding,
} from "./bindings.service";
import { AppProject } from "../database/workspace-schema";

function mockStore(
  existingKeys: string[],
  /** Write time per key; an existing key without one has an unknown time. */
  modifiedAt: Record<string, Date> = {},
): ArtifactStore {
  const keys = new Set(existingKeys);
  return {
    type: "gcs",
    exists: vi.fn(async key => keys.has(key)),
    put: vi.fn(),
    putBuffer: vi.fn(),
    getSignedUrl: vi.fn(),
    openReadStream: vi.fn(async key =>
      keys.has(key) ? Readable.from(["deployment"]) : null,
    ),
    getSize: vi.fn(async key => (keys.has(key) ? 10 : null)),
    getLastModified: vi.fn(async key =>
      keys.has(key) ? (modifiedAt[key] ?? null) : null,
    ),
    delete: vi.fn(),
  };
}

describe("published deployment artifact source", () => {
  const projectId = "6a9411eb4c8b33609a65e665";
  const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
  const indexKey = deploymentKey(projectId, sha, "index.html");

  beforeEach(() => {
    stores.primary = mockStore([]);
    stores.source = undefined;
    stores.bindings = [];
    vi.clearAllMocks();
  });

  it("falls back to the read-only source when the preview bucket is empty", async () => {
    stores.source = mockStore([indexKey]);

    const asset = await readDeploymentAsset(projectId, sha, "");

    expect(asset).toMatchObject({
      contentType: "text/html; charset=utf-8",
      size: 10,
    });
    expect(stores.primary.exists).toHaveBeenCalledWith(indexKey);
    expect(stores.primary.openReadStream).not.toHaveBeenCalled();
    expect(stores.source.openReadStream).toHaveBeenCalledWith(indexKey);
  });

  it("opens an asset in one store call when the store can", async () => {
    const primary = mockStore([indexKey]);
    primary.openRead = vi.fn(async (key: string) =>
      key === indexKey
        ? { stream: Readable.from([Buffer.from("<html></html>")]), size: 13 }
        : null,
    );
    stores.primary = primary;

    const response = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "index.html",
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe("13");
    expect(await response?.text()).toBe("<html></html>");
    expect(primary.openRead).toHaveBeenCalledTimes(1);
    expect(primary.exists).not.toHaveBeenCalled();
    expect(primary.getSize).not.toHaveBeenCalled();
  });

  it("answers a missing asset with null after one call per place looked", async () => {
    const primary = mockStore([]);
    primary.openRead = vi.fn(async () => null);
    stores.primary = primary;

    const response = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "assets/missing.js",
    });

    expect(response).toBeNull();
    // The current key, then the legacy key; no SPA fallback for a file path.
    expect(primary.openRead).toHaveBeenCalledTimes(2);
    expect(primary.exists).not.toHaveBeenCalled();
  });

  it("falls back to the read-only source through openRead too", async () => {
    const primary = mockStore([]);
    primary.openRead = vi.fn(async () => null);
    const source = mockStore([indexKey]);
    source.openRead = vi.fn(async (key: string) =>
      key === indexKey ? { stream: Readable.from(["src"]), size: null } : null,
    );
    stores.primary = primary;
    stores.source = source;

    const asset = await readDeploymentAsset(projectId, sha, "some/route");

    expect(asset?.size).toBeNull();
    expect(asset?.contentType).toBe("text/html; charset=utf-8");
    // some/route misses both stores at both keys, then index.html hits the
    // source at the current key.
    expect(source.openRead).toHaveBeenLastCalledWith(indexKey);
  });

  it("prefers the isolated writable store when it has the deployment", async () => {
    stores.primary = mockStore([indexKey]);
    stores.source = mockStore([indexKey]);

    expect(await deploymentExists(projectId, sha)).toBe(true);

    expect(stores.primary.exists).toHaveBeenCalledWith(indexKey);
    expect(stores.source.exists).not.toHaveBeenCalled();
  });

  it("serves published binding data from the read-only source", async () => {
    const bindingKey = "apps/bindings/connection/binding.parquet";
    stores.source = mockStore([bindingKey]);

    const response = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/icp_customers.parquet",
    });

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(`true:${bindingKey}`);
    expect(stores.primary.exists).toHaveBeenCalledWith(bindingKey);
    expect(stores.source.exists).toHaveBeenCalledWith(bindingKey);
  });

  it("answers __data/viewer.json for the signed-in viewer, and null when nobody is known", async () => {
    const known = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/viewer.json",
      viewer: { id: "u1", email: "sam@acme.com" },
    });
    expect(known?.status).toBe(200);
    expect(known?.headers.get("cache-control")).toBe("no-store");
    expect(await known?.json()).toMatchObject({
      email: "sam@acme.com",
      workspace: { role: "viewer" },
      app: { role: "viewer" },
    });

    const anonymous = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/viewer.json",
      private: true,
      viewer: null,
    });
    expect(anonymous?.status).toBe(200);
    expect(anonymous?.headers.get("cache-control")).toBe("private, no-store");
    expect(await anonymous?.json()).toBeNull();
    // Never a store read: identity is not an artifact.
    expect(stores.primary.exists).not.toHaveBeenCalled();
  });
});

describe("deployment binding index", () => {
  const projectId = "6a9411eb4c8b33609a65e665";
  const project = { _id: { toString: () => projectId } } as never;

  beforeEach(() => {
    stores.primary = mockStore([]);
    stores.source = undefined;
    stores.skipped = [];
    stores.bindings = [
      {
        name: "sales",
        connectionId: "warehouse",
        materialization: "parquet",
        code: "select 1",
        sql: "select 1",
      },
    ];
    vi.clearAllMocks();
  });

  it("is written next to the deployment once its bindings are ready", async () => {
    const sha = "1111111111111111111111111111111111111111";
    await ensureDeploymentBindings(project, sha);

    expect(stores.primary!.putBuffer).toHaveBeenCalledWith(
      Buffer.from(
        JSON.stringify({ sales: "apps/bindings/warehouse/sales.parquet" }),
      ),
      deploymentKey(projectId, sha, DEPLOYMENT_BINDING_INDEX),
      "application/json",
    );
  });

  it("serves binding data and the table list without reading the repository", async () => {
    const sha = "2222222222222222222222222222222222222222";
    const indexKey = deploymentKey(projectId, sha, DEPLOYMENT_BINDING_INDEX);
    const bindingKey = "apps/bindings/warehouse/sales.parquet";
    const snapshotKey = "apps/bindings/warehouse/sales.snapshot.json";
    const store = mockStore([indexKey, bindingKey, snapshotKey]);
    store.openReadStream = vi.fn(async key =>
      key === indexKey
        ? Readable.from([JSON.stringify({ sales: bindingKey })])
        : null,
    );
    stores.primary = store;

    const data = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/sales.parquet",
    });
    expect(await data?.text()).toBe(`false:${bindingKey}`);

    // A client that asked for phases gets the signed link on the stream,
    // not a 302 whose Location fetch() would swallow.
    store.getSignedUrl = vi.fn(async () => "https://storage.test/s?sig=1");
    const progress = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/sales.parquet",
      progress: true,
    });
    expect(progress?.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await (progress as Response).text())
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(lines.map(e => e.phase)).toEqual(["resolving", "signing", "ready"]);
    expect(lines[2]).toMatchObject({
      binding: "sales",
      url: "https://storage.test/s?sig=1",
    });
    expect(store.getSignedUrl).toHaveBeenCalledWith(bindingKey, 600);

    const snapshot = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/sales.snapshot.json",
    });
    expect(await snapshot?.text()).toBe(`json:false:${snapshotKey}`);

    const names = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/index.json",
    });
    expect(await names?.json()).toEqual(["sales"]);

    // not a binding at this commit, nor a key of Object.prototype
    for (const name of ["other", "constructor"]) {
      const missing = await serveDeploymentFile({
        projectId,
        sha,
        assetPath: `__data/${name}.parquet`,
      });
      expect(missing).toBeNull();
    }

    for (const name of ["other", "constructor"]) {
      const missing = await serveDeploymentFile({
        projectId,
        sha,
        assetPath: `__data/${name}.snapshot.json`,
      });
      expect(missing).toBeNull();
    }

    // the index itself is not a file of the app
    expect(
      await serveDeploymentFile({
        projectId,
        sha,
        assetPath: DEPLOYMENT_BINDING_INDEX,
      }),
    ).toBeNull();

    expect(bindingArtifactKeyByName).not.toHaveBeenCalled();
    expect(readBindingsTolerant).not.toHaveBeenCalled();
    // read once, then cached: a deployment's keys never change
    expect(
      vi
        .mocked(store.openReadStream)
        .mock.calls.filter(([k]) => k === indexKey),
    ).toHaveLength(1);
  });

  it("answers a snapshot 404 cheaply: no index means no snapshot, never a repo read", async () => {
    const sha = "3333333333333333333333333333333333333333";
    const bindingKey = "apps/bindings/warehouse/sales.parquet";
    // An older deployment: no binding index, parquet present, no snapshot.
    stores.primary = mockStore([bindingKey]);
    expect(
      await serveDeploymentFile({
        projectId,
        sha,
        assetPath: "__data/sales.snapshot.json",
      }),
    ).toBeNull();
    expect(bindingArtifactKeyByName).not.toHaveBeenCalled();

    // Indexed, but built before snapshots existed.
    const sha2 = "4444444444444444444444444444444444444444";
    const indexKey = deploymentKey(projectId, sha2, DEPLOYMENT_BINDING_INDEX);
    const store = mockStore([indexKey, bindingKey]);
    store.openReadStream = vi.fn(async key =>
      key === indexKey
        ? Readable.from([JSON.stringify({ sales: bindingKey })])
        : null,
    );
    stores.primary = store;
    expect(
      await serveDeploymentFile({
        projectId,
        sha: sha2,
        assetPath: "__data/sales.snapshot.json",
      }),
    ).toBeNull();
    expect(bindingArtifactKeyByName).not.toHaveBeenCalled();
    expect(readBindingsTolerant).not.toHaveBeenCalled();
  });
});

describe("deployment binding readiness", () => {
  const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
  const project = {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
  } as never;

  beforeEach(() => {
    stores.primary = mockStore([]);
    stores.source = undefined;
    stores.skipped = [];
    stores.bindings = [
      {
        name: "sales",
        connectionId: "warehouse",
        materialization: "parquet",
        code: "select 1",
        sql: "select 1",
      },
    ];
    vi.clearAllMocks();
  });

  it("reuses a content-addressed artifact and reads definitions at the deployment sha", async () => {
    stores.source = mockStore(["apps/bindings/warehouse/sales.parquet"]);

    const result = await ensureDeploymentBindings(project, sha);

    expect(result).toEqual({
      required: ["sales"],
      reused: ["sales"],
      materialized: [],
      refreshing: [],
      skipped: [],
    });
    expect(readBindingsTolerant).toHaveBeenCalledWith(project, "publish", sha);
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("materializes a missing artifact from the exact deployment sha", async () => {
    const result = await ensureDeploymentBindings(project, sha);

    expect(result.materialized).toEqual(["sales"]);
    // The binding it read goes along: re-reading every file under bindings/
    // per build cost 13 s each on a 134-binding app.
    expect(materializeAppBinding).toHaveBeenCalledWith(
      project,
      "sales",
      "publish",
      { at: sha, binding: stores.bindings[0] },
    );
  });

  it("does not let a malformed neighbour pin the app at its old deployment", async () => {
    stores.skipped = [
      {
        path: "bindings/draft (copy).sql",
        error: "Invalid binding filename: bindings/draft (copy).sql",
      },
    ];

    const result = await ensureDeploymentBindings(project, sha);

    // The healthy binding is prepared; the stray file is reported, not fatal
    // — its data URL 404s exactly as the serving path already isolates it.
    expect(result.materialized).toEqual(["sales"]);
    expect(result.skipped).toEqual(stores.skipped);
  });

  describe("the 2026-11-03 release: 134 bindings on an hourly cron", () => {
    const hourly = { schedule: "55 * * * *", timezone: "UTC" };
    const startedAt = new Date("2026-11-03T03:36:06Z");
    const keyOf = (name: string) => `apps/bindings/warehouse/${name}.parquet`;
    const binding = (name: string) => ({
      name,
      connectionId: "warehouse",
      materialization: "parquet" as const,
      code: `select '${name}'`,
      sql: `select '${name}'`,
      ...hourly,
    });

    /** 22 new bindings, 112 present and built before the 02:55 occurrence. */
    function seedRelease() {
      const fresh = Array.from({ length: 22 }, (_, i) => `new_${i}`);
      const stale = Array.from({ length: 112 }, (_, i) => `old_${i}`);
      stores.bindings = [...fresh, ...stale].map(binding);
      stores.primary = mockStore(
        stale.map(keyOf),
        Object.fromEntries(
          stale.map(name => [keyOf(name), new Date("2026-11-03T02:16:00Z")]),
        ),
      );
      return { fresh, stale };
    }

    /** materializeAppBinding that yields, so concurrent calls overlap. */
    function trackBuilds() {
      const seen = { peak: 0, running: 0 };
      vi.mocked(materializeAppBinding).mockImplementation(async () => {
        seen.running += 1;
        seen.peak = Math.max(seen.peak, seen.running);
        await new Promise(resolve => setImmediate(resolve));
        seen.running -= 1;
        return {
          artifactKey: "k",
          rowCount: 1,
          byteSize: 10,
          materializedAt: new Date(),
        };
      });
      return seen;
    }

    it("builds only the 22 absent artifacts, 2 at a time, and reports the other 112 for refresh", async () => {
      const { fresh, stale } = seedRelease();
      const builds = trackBuilds();

      const result = await ensureDeploymentBindings(project, sha, {
        now: startedAt,
      });

      expect(result.materialized).toEqual(fresh);
      expect(result.refreshing).toEqual(stale);
      expect(result.reused).toEqual([]);
      expect(materializeAppBinding).toHaveBeenCalledTimes(22);
      expect(builds.peak).toBe(2);
      // Queued by the repoint: a refresh stands down for a commit not yet live.
      expect(refreshes.send).not.toHaveBeenCalled();
    });

    it("judges every binding before the first build, so a :55 crossing during the builds changes nothing", async () => {
      seedRelease();
      const primary = stores.primary!;
      let judgedBeforeFirstBuild = -1;
      vi.mocked(materializeAppBinding).mockImplementation(async () => {
        if (judgedBeforeFirstBuild < 0) {
          judgedBeforeFirstBuild = vi.mocked(primary.getLastModified).mock.calls
            .length;
        }
        return {
          artifactKey: "k",
          rowCount: 1,
          byteSize: 10,
          materializedAt: new Date(),
        };
      });

      await ensureDeploymentBindings(project, sha, { now: startedAt });

      expect(judgedBeforeFirstBuild).toBe(112);
      expect(vi.mocked(primary.getLastModified).mock.calls.length).toBe(112);
    });

    it("reports every binding as prepared when the builds finish", async () => {
      seedRelease();
      trackBuilds();

      await ensureDeploymentBindings(project, sha, { now: startedAt });

      const progress = vi
        .mocked(AppProject.updateOne)
        .mock.calls.map(
          call =>
            (call[1] as { $set?: Record<string, unknown> }).$set?.[
              "deployProgress.bindings"
            ] as { prepared: number; total: number } | undefined,
        )
        .filter(Boolean);
      expect(progress[0]).toEqual({ total: 134, prepared: 0 });
      expect(progress.at(-1)).toEqual({ total: 134, prepared: 134 });
    });

    it("a failed build blocks the release, names the binding and starts nothing new", async () => {
      const { fresh } = seedRelease();
      vi.mocked(materializeAppBinding).mockImplementation(
        async (_project, name) => {
          if (name === fresh[1]) throw new Error("HTTP 401");
          await new Promise(resolve => setImmediate(resolve));
          return {
            artifactKey: "k",
            rowCount: 1,
            byteSize: 10,
            materializedAt: new Date(),
          };
        },
      );

      await expect(
        ensureDeploymentBindings(project, sha, { now: startedAt }),
      ).rejects.toThrow('Binding "new_1": HTTP 401');

      // The two already running; the other 20 never start.
      expect(materializeAppBinding).toHaveBeenCalledTimes(2);
      expect(stores.primary!.putBuffer).not.toHaveBeenCalled();
    });

    it("a refresh that cannot be queued does not stop the repoint", async () => {
      vi.mocked(AppProject.updateOne).mockResolvedValueOnce({
        matchedCount: 1,
      } as never);
      refreshes.send.mockRejectedValueOnce(new Error("inngest down"));

      await expect(
        setPublishedSha(project, sha, { refreshing: ["old_0"] }),
      ).resolves.toBe(true);
    });

    it("the repoint queues the refreshes once the release is live", async () => {
      vi.mocked(AppProject.updateOne).mockResolvedValueOnce({
        matchedCount: 1,
      } as never);

      await setPublishedSha(project, sha, { refreshing: ["old_0", "old_1"] });

      expect(refreshes.send).toHaveBeenCalledWith(project, sha, [
        "old_0",
        "old_1",
      ]);
    });

    it("a conditional repoint that lost queues nothing and says so", async () => {
      vi.mocked(AppProject.updateOne).mockResolvedValueOnce({
        matchedCount: 0,
      } as never);

      await expect(
        setPublishedSha(project, sha, {
          expected: "1".repeat(40),
          refreshing: ["old_0"],
        }),
      ).resolves.toBe(false);

      expect(vi.mocked(AppProject.updateOne).mock.calls[0][0]).toMatchObject({
        publishedSha: "1".repeat(40),
      });
      expect(refreshes.send).not.toHaveBeenCalled();
    });
  });

  describe("scheduled bindings", () => {
    const key = "apps/bindings/warehouse/sales.parquet";
    // "44 7 * * *" Europe/Paris = 05:44Z in September (CEST).
    const schedule = { schedule: "44 7 * * *", timezone: "Europe/Paris" };
    const deployAt = new Date("2026-09-08T06:46:00Z");

    it("reuses an artifact built after the schedule's latest occurrence", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      stores.primary = mockStore([key], {
        [key]: new Date("2026-09-08T05:47:00Z"),
      });

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual(["sales"]);
      expect(result.materialized).toEqual([]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
    });

    it("goes live on an artifact older than the schedule's latest occurrence and refreshes it at the deployment sha", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      stores.primary = mockStore([key], {
        [key]: new Date("2026-09-07T12:00:00Z"),
      });

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual([]);
      expect(result.materialized).toEqual([]);
      expect(result.refreshing).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
    });

    it("#992: a merge reverting the query to an older text queues a refresh of that text, whatever the scheduler state says", async () => {
      // fr-sales-dashboard, binding fr_demos, "44 7 * * *" Europe/Paris.
      // Day 1 07:49: the scheduler built text A. Day 1 17:24: an edit to
      // text B was published. Day 2 07:47: the scheduler built B (main).
      // Day 2 08:45: a merge reverted the file to A. A's key is still in the
      // store from day 1 NEXT TO the fresh sibling artifact for B, and the
      // per-name scheduler state says the binding ran today — neither the
      // sibling nor that state may vouch for A's day-old bytes.
      const siblingKey = "apps/bindings/warehouse/other-text.parquet";
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      const primary = mockStore([key, siblingKey], {
        [key]: new Date("2026-09-07T05:49:00Z"),
        [siblingKey]: new Date("2026-09-08T05:47:00Z"),
      });
      stores.primary = primary;

      const result = await ensureDeploymentBindings(project, sha, {
        now: new Date("2026-09-08T06:46:00Z"),
      });

      expect(result.reused).toEqual([]);
      expect(result.refreshing).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
      expect(primary.getLastModified).toHaveBeenCalledTimes(1);
      expect(primary.getLastModified).toHaveBeenCalledWith(key);
    });

    it("materializes a scheduled binding with no artifact exactly once", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      const primary = mockStore([]);
      stores.primary = primary;

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.materialized).toEqual(["sales"]);
      expect(materializeAppBinding).toHaveBeenCalledTimes(1);
      // Nothing to date when nothing is there.
      expect(primary.getLastModified).not.toHaveBeenCalled();
    });

    it("refreshes when the store cannot say how old the artifact is", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      stores.primary = mockStore([key]);

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.refreshing).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
    });

    it("keeps reusing an unscheduled binding's artifact however old it is", async () => {
      const primary = mockStore([key], {
        [key]: new Date("2020-01-01T00:00:00Z"),
      });
      stores.primary = primary;

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
      // Nothing to check without a schedule: no extra store round trip.
      expect(primary.getLastModified).not.toHaveBeenCalled();
    });

    it("reuses and warns instead of failing the publish when the schedule is unparseable", async () => {
      stores.bindings[0] = { ...stores.bindings[0], schedule: "not a cron" };
      const primary = mockStore([key], {
        [key]: new Date("2020-01-01T00:00:00Z"),
      });
      stores.primary = primary;

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      // The scheduler log-and-skips such a binding; publish must not fail
      // (or rebuild on every publish) because of it — effectively unscheduled.
      expect(result.reused).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
      expect(primary.getLastModified).not.toHaveBeenCalled();
    });

    it("treats an unknown timezone like an unparseable schedule", async () => {
      stores.bindings[0] = {
        ...stores.bindings[0],
        ...schedule,
        timezone: "Mars/Olympus",
      };
      const primary = mockStore([key], {
        [key]: new Date("2020-01-01T00:00:00Z"),
      });
      stores.primary = primary;

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual(["sales"]);
      expect(materializeAppBinding).not.toHaveBeenCalled();
      expect(primary.getLastModified).not.toHaveBeenCalled();
    });

    it("reads the build time from the store that holds the artifact", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      const primary = mockStore([]);
      const source = mockStore([key], {
        [key]: new Date("2026-09-08T05:47:00Z"),
      });
      stores.primary = primary;
      stores.source = source;

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual(["sales"]);
      expect(source.getLastModified).toHaveBeenCalledWith(key);
      expect(primary.getLastModified).not.toHaveBeenCalled();
    });
  });

  it("rejects dev-only live bindings instead of publishing a broken data URL", async () => {
    stores.bindings[0].materialization = "live";

    await expect(ensureDeploymentBindings(project, sha)).rejects.toThrow(
      /Cannot publish live binding "sales"/,
    );
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("keeps the low-level deploy primitive data-safe by default", async () => {
    const handle = {
      project,
      appRoot: "apps/sales",
      doc: {
        workspaceId: "6a9411eb4c8b33609a65e666",
        userId: "publish",
      },
    } as never;

    await deployBuild(project, sha, handle);

    expect(materializeAppBinding).toHaveBeenCalledWith(
      project,
      "sales",
      "publish",
      { at: sha, binding: stores.bindings[0] },
    );
  });
});
