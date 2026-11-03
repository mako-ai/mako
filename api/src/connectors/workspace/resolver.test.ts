import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ present: false }));
const ensureCommitLocally = vi.hoisted(() =>
  vi.fn(async () => {
    cache.present = true;
  }),
);
vi.mock("../../apps/cloud-repo.service", () => ({ ensureCommitLocally }));
vi.mock("../../apps/repository.service", () => ({
  DEFAULT_BRANCH: "main",
  repoDirFor: () => "/cached/repo",
  repoExists: async () => true,
  resolveCommit: vi.fn(),
  listTree: async () => {
    if (!cache.present) throw new Error("fatal: not a tree object");
    return [{ path: "connectors/acme/connector.ts", size: 4 }];
  },
  readBlobsBatch: async () =>
    new Map([["connectors/acme/connector.ts", Buffer.from("code")]]),
}));
vi.mock("../../database/workspace-schema", () => ({ ConnectorDefinition: {} }));
vi.mock("./sync-box", () => ({
  CONNECTOR_NODE_VERSION: "22",
  hasConnectorRuntime: vi.fn(),
  installConnectorRuntime: vi.fn(),
}));
import { readConnectorFolder } from "./resolver";

beforeEach(() => {
  cache.present = false;
  ensureCommitLocally.mockClear();
});
describe("pinned connector source on a stale API replica", () => {
  it("fetches the pinned commit before reading its tree", async () => {
    const commit = "a".repeat(40);
    const files = await readConnectorFolder("workspace", "acme", commit);
    expect(ensureCommitLocally).toHaveBeenCalledWith("workspace", commit);
    expect(Buffer.from(files.get("connector.ts") ?? []).toString()).toBe(
      "code",
    );
  });
});
