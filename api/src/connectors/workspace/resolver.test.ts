import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ present: false, fetchesUntilPresent: 1 }));
const ensureCommitLocally = vi.hoisted(() =>
  vi.fn(async () => {
    cache.fetchesUntilPresent--;
    if (cache.fetchesUntilPresent <= 0) cache.present = true;
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
import { createHash } from "node:crypto";
import { readConnectorFolder, runtimeIdOf, RUNTIME_LAYOUT } from "./resolver";

beforeEach(() => {
  cache.present = false;
  cache.fetchesUntilPresent = 1;
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

  it("reads again once when the commit lands just after the first fetch", async () => {
    // The row's commit reaches the mirror a moment after it was indexed.
    cache.fetchesUntilPresent = 2;
    const commit = "b".repeat(40);
    const files = await readConnectorFolder("workspace", "acme", commit);
    expect(ensureCommitLocally).toHaveBeenCalledTimes(2);
    expect(files.has("connector.ts")).toBe(true);
  });

  it("throws on a second miss, so the sync step retries", async () => {
    cache.fetchesUntilPresent = 99;
    await expect(
      readConnectorFolder("workspace", "acme", "c".repeat(40)),
    ).rejects.toThrow(/not a tree object/);
    expect(ensureCommitLocally).toHaveBeenCalledTimes(2);
  });
});

describe("runtime id", () => {
  const files = new Map([
    ["package.json", new TextEncoder().encode("{}")],
    ["src/run.js", new TextEncoder().encode("export const run = 1;\n")],
  ]);
  /** The id before the manifest layout: Node version and SDK bytes only. */
  const preManifestId = () => {
    const hash = createHash("sha256");
    hash.update("node:22\0");
    for (const name of [...files.keys()].sort()) {
      hash.update(name);
      hash.update("\0");
      hash.update(files.get(name) as Uint8Array);
      hash.update("\0");
    }
    return hash.digest("hex");
  };

  it("differs from the id of a root or template without a manifest", () => {
    expect(RUNTIME_LAYOUT).toBe("manifest-v1");
    expect(runtimeIdOf(files)).not.toBe(preManifestId());
  });

  it("is stable for the same SDK bytes", () => {
    expect(runtimeIdOf(files)).toBe(runtimeIdOf(new Map(files)));
  });
});
