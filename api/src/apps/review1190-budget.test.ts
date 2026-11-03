/**
 * Review of PR #1190: the per-workspace build limit across walks.
 */
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ running: 0, peak: 0 }));

vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    type: "gcs",
    exists: vi.fn(async () => false),
    putBuffer: vi.fn(async () => undefined),
  }),
  getArtifactSourceStore: () => null,
}));
vi.mock("../inngest/functions/apps-binding-refresh", () => ({
  requestBindingRefreshes: vi.fn(async () => undefined),
}));
vi.mock("./bindings.service", () => ({
  bindingArtifactKey: vi.fn((b: { name: string }) => b.name),
  bindingArtifactKeyByName: vi.fn(),
  materializeAppBinding: vi.fn(async () => {
    seen.running += 1;
    seen.peak = Math.max(seen.peak, seen.running);
    await new Promise(resolve => setTimeout(resolve, 5));
    seen.running -= 1;
    return { rowCount: 1 };
  }),
  readBindingsTolerant: vi.fn(async () => ({
    bindings: Array.from({ length: 20 }, (_, i) => ({
      name: `b${i}`,
      connectionId: "c",
      materialization: "parquet",
    })),
    skipped: [],
  })),
}));
vi.mock("../database/workspace-schema", () => ({
  AppProject: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
}));

import { ensureDeploymentBindings } from "./deployment.service";
import type { IAppProject } from "../database/workspace-schema";

const project = (id: string) =>
  ({
    _id: { toString: () => id },
    workspaceId: { toString: () => "ws" },
  }) as unknown as IAppProject;

describe("workspace build budget", () => {
  it("DEFECT: two apps' walks plus 4 scheduled builds must stay inside the warehouse limit of 4", async () => {
    await Promise.all([
      ensureDeploymentBindings(
        project("6a9411eb4c8b33609a65e661"),
        "a".repeat(40),
      ),
      ensureDeploymentBindings(
        project("6a9411eb4c8b33609a65e662"),
        "b".repeat(40),
      ),
    ]);
    // apps-deploy allows 2 per workspace, so this is reachable with no zombie.
    // The 4 Inngest builds of the same workspace come on top of this figure.
    expect(seen.peak).toBeLessThanOrEqual(4);
  });
});
