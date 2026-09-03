import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardArtifactStore } from "../services/dashboard-artifact-store.service";

const stores = vi.hoisted(() => ({
  primary: undefined as DashboardArtifactStore | undefined,
  source: undefined as DashboardArtifactStore | undefined,
}));

vi.mock("../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: () => stores.primary,
  getArtifactSourceStore: () => stores.source ?? null,
}));

vi.mock("./bindings.service", () => ({
  bindingArtifactKeyByName: vi.fn(
    async () => "apps/bindings/connection/binding.parquet",
  ),
  readBindings: vi.fn(async () => []),
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

import {
  deploymentExists,
  deploymentKey,
  readDeploymentAsset,
  serveDeploymentFile,
} from "./deployment.service";

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
