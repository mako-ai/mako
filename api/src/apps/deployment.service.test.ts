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

import {
  deploymentExists,
  deploymentKey,
  readDeploymentAsset,
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
});
