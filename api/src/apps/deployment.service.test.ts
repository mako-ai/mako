import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const stores = vi.hoisted(() => ({
  primary: undefined as DashboardArtifactStore | undefined,
  source: undefined as DashboardArtifactStore | undefined,
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

vi.mock("../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: () => stores.primary,
  getArtifactSourceStore: () => stores.source ?? null,
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
  serveParquetArtifact: vi.fn(
    async (store, key) =>
      new Response(`${store === stores.source}:${key}`, { status: 200 }),
  ),
}));

vi.mock("./box", () => ({
  readBoxDir: vi.fn(async (_ctx, _source, destination: string) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${destination}/index.html`, "<html></html>");
  }),
}));

import {
  deployBuild,
  deploymentExists,
  deploymentKey,
  ensureDeploymentBindings,
  readDeploymentAsset,
  serveDeploymentFile,
} from "./deployment.service";
import {
  materializeAppBinding,
  readBindingsTolerant,
  type AppBinding,
} from "./bindings.service";

function mockStore(
  existingKeys: string[],
  /** Write time per key; an existing key without one has an unknown time. */
  modifiedAt: Record<string, Date> = {},
): DashboardArtifactStore {
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
      skipped: [],
    });
    expect(readBindingsTolerant).toHaveBeenCalledWith(project, "publish", sha);
    expect(materializeAppBinding).not.toHaveBeenCalled();
  });

  it("materializes a missing artifact from the exact deployment sha", async () => {
    const result = await ensureDeploymentBindings(project, sha);

    expect(result.materialized).toEqual(["sales"]);
    expect(materializeAppBinding).toHaveBeenCalledWith(
      project,
      "sales",
      "publish",
      { at: sha },
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

    it("rebuilds an artifact older than the schedule's latest occurrence at the deployment sha", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      stores.primary = mockStore([key], {
        [key]: new Date("2026-09-07T12:00:00Z"),
      });

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.reused).toEqual([]);
      expect(result.materialized).toEqual(["sales"]);
      expect(materializeAppBinding).toHaveBeenCalledWith(
        project,
        "sales",
        "publish",
        { at: sha },
      );
    });

    it("reproduces #992: a merge reverting the query to an older text must not serve yesterday's build", async () => {
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
      expect(result.materialized).toEqual(["sales"]);
      expect(materializeAppBinding).toHaveBeenCalledTimes(1);
      expect(materializeAppBinding).toHaveBeenCalledWith(
        project,
        "sales",
        "publish",
        { at: sha },
      );
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

    it("rebuilds when the store cannot say how old the artifact is", async () => {
      stores.bindings[0] = { ...stores.bindings[0], ...schedule };
      stores.primary = mockStore([key]);

      const result = await ensureDeploymentBindings(project, sha, {
        now: deployAt,
      });

      expect(result.materialized).toEqual(["sales"]);
      expect(materializeAppBinding).toHaveBeenCalledTimes(1);
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
      { at: sha },
    );
  });
});
