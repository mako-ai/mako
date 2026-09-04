import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const stores = vi.hoisted(() => ({
  primary: undefined as DashboardArtifactStore | undefined,
  source: undefined as DashboardArtifactStore | undefined,
  bindings: [] as Array<{
    name: string;
    connectionId: string;
    materialization: "parquet" | "live";
    code: string;
    sql: string;
  }>,
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
  readBindings: vi.fn(async () => stores.bindings),
}));

vi.mock("../database/workspace-schema", () => ({
  AppProject: {
    findById: vi.fn(async () => ({ _id: "project" })),
    updateOne: vi.fn(),
  },
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
import { materializeAppBinding, readBindings } from "./bindings.service";

function mockStore(existingKeys: string[]): DashboardArtifactStore {
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
});

describe("deployment binding readiness", () => {
  const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
  const project = {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
  } as never;

  beforeEach(() => {
    stores.primary = mockStore([]);
    stores.source = undefined;
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
    });
    expect(readBindings).toHaveBeenCalledWith(project, "publish", sha);
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
