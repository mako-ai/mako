/**
 * Where a workspace connector's commands run, with the lease flag off and on.
 *
 * Off (the default): exactly the old path, the workspace's one sync box, and
 * the scheduler is never touched. On: every command holds a lease on a box
 * keyed by the connection and the connector's source sha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runConnectorCommand: vi.fn(),
  materializeConnector: vi.fn(),
  ensureBundle: vi.fn(),
  ensureConnectorRuntime: vi.fn(),
  connectorRuntimeId: vi.fn(),
  readConnectorFolder: vi.fn(),
  loadConnectorDefinition: vi.fn(),
  withLease: vi.fn(),
  getBoxScheduler: vi.fn(),
}));

vi.mock("./sync-box", async importOriginal => ({
  ...(await importOriginal<typeof import("./sync-box")>()),
  runConnectorCommand: mocks.runConnectorCommand,
  materializeConnector: mocks.materializeConnector,
  ensureBundle: mocks.ensureBundle,
}));
vi.mock("./resolver", () => ({
  ensureConnectorRuntime: mocks.ensureConnectorRuntime,
  connectorRuntimeId: mocks.connectorRuntimeId,
  readConnectorFolder: mocks.readConnectorFolder,
  loadConnectorDefinition: mocks.loadConnectorDefinition,
}));
vi.mock("./boxes/scheduler", () => ({
  getBoxScheduler: mocks.getBoxScheduler,
}));

import { SandboxedConnector } from "./SandboxedConnector";

const status = {
  exitCode: 0,
  messages: [
    { type: "CONNECTION_STATUS", connectionStatus: { status: "SUCCEEDED" } },
  ],
  malformed: [],
  stderr: "",
  timedOut: false,
};

function connector(id: string | null = "665f00000000000000000001") {
  return new SandboxedConnector({
    ...(id ? { _id: id } : {}),
    workspaceId: "ws1",
    name: "Acme",
    type: "ws:acme",
    config: { apiKey: "secret" },
  } as never);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.loadConnectorDefinition.mockResolvedValue({
    slug: "acme",
    sha: "commit-sha",
    sourceSha: "source-sha",
    entry: "connector.ts",
    entities: [],
  });
  mocks.ensureConnectorRuntime.mockResolvedValue("rt-1");
  mocks.connectorRuntimeId.mockResolvedValue("rt-1");
  mocks.readConnectorFolder.mockResolvedValue(new Map());
  mocks.materializeConnector.mockResolvedValue("/tmp/acme");
  mocks.ensureBundle.mockResolvedValue({ runtimeId: "rt-1", dir: "/tmp/acme" });
  mocks.runConnectorCommand.mockResolvedValue(status);
  mocks.getBoxScheduler.mockReturnValue({ withLease: mocks.withLease });
  mocks.withLease.mockImplementation(async (_run, fn) =>
    fn({
      boxId: "cbx_1",
      runId: "run_1",
      ctx: { sessionKey: "connector-box:cbx_1" },
      fresh: true,
      markFailed: vi.fn(),
      noteRuntime: vi.fn(),
    }),
  );
});

afterEach(() => {
  delete process.env.CONNECTOR_BOX_LEASES;
});

describe("flag off", () => {
  it("runs in the workspace's sync box and never touches the scheduler", async () => {
    const result = await connector().testConnection();

    expect(result.success).toBe(true);
    expect(mocks.getBoxScheduler).not.toHaveBeenCalled();
    expect(mocks.withLease).not.toHaveBeenCalled();
    expect(mocks.ensureBundle).not.toHaveBeenCalled();
    expect(mocks.ensureConnectorRuntime).toHaveBeenCalledWith({
      sessionKey: "connector-sync:ws1",
    });
    expect(mocks.runConnectorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: { sessionKey: "connector-sync:ws1" },
        command: "check",
        connectorDir: "/tmp/acme",
        runtimeId: "rt-1",
      }),
    );
  });

  it("treats any value but exactly true as off", async () => {
    process.env.CONNECTOR_BOX_LEASES = "1";
    await connector().testConnection();
    expect(mocks.withLease).not.toHaveBeenCalled();
  });
});

describe("flag on", () => {
  beforeEach(() => {
    process.env.CONNECTOR_BOX_LEASES = "true";
  });

  it("leases a box keyed by the connection and the source sha", async () => {
    const result = await connector().testConnection();

    expect(result.success).toBe(true);
    expect(mocks.withLease).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        connectionId: "665f00000000000000000001",
        bundleHash: "source-sha",
        command: "check",
        runtimeId: "rt-1",
        oneOff: false,
      }),
      expect.any(Function),
    );
    expect(mocks.ensureBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: { sessionKey: "connector-box:cbx_1" },
        hash: "source-sha",
        slug: "acme",
      }),
    );
    expect(mocks.runConnectorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: { sessionKey: "connector-box:cbx_1" },
        command: "check",
      }),
    );
  });

  it("gives a connection that is not saved yet a one-off box", async () => {
    await connector(null).testConnection();
    const [spec] = mocks.withLease.mock.calls[0];
    expect(spec.connectionId).toMatch(/^unsaved:[0-9a-f]{16}$/);
    expect(spec.oneOff).toBe(true);
  });
});
