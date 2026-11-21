import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  resolveTrusted: vi.fn(),
  prepare: vi.fn(),
  runtime: vi.fn(),
  run: vi.fn(),
  withLease: vi.fn(),
  markFailed: vi.fn(),
  markUnhealthy: vi.fn(),
}));

vi.mock("../registry/stripe-release", () => ({
  resolveStripeRelease: mocks.resolve,
  resolveTrustedRelease: mocks.resolveTrusted,
}));
vi.mock("../registry/registry.service", () => ({
  prepareRegistryConnector: mocks.prepare,
}));
vi.mock("../resolver", () => ({ ensureConnectorRuntime: mocks.runtime }));
vi.mock("./scheduler", () => ({
  getBoxScheduler: () => ({ withLease: mocks.withLease }),
}));
vi.mock("../sync-box", async importOriginal => ({
  ...(await importOriginal<typeof import("../sync-box")>()),
  runConnectorCommand: mocks.run,
}));

import { loadStripeRegistryMetadata } from "../registry/stripe-metadata";
import { bindCalendlyRelease } from "../registry/calendly-binding";

const registry = {
  ref: "mako/stripe@1.2.3",
  slug: "stripe",
  version: "1.2.3",
  hash: "bundle-hash",
  sha256: "a".repeat(64),
};
const pin = { version: registry.version, sha256: registry.sha256 };
const ctx = { sessionKey: "connector-box:synthetic" };
const spec = { connectionSpecification: { properties: {} } };
const output = (messages: unknown[], changes = {}) => ({
  exitCode: 0,
  timedOut: false,
  stderr: "",
  malformed: [],
  messages,
  ...changes,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(registry);
  mocks.runtime.mockResolvedValue("runtime");
  mocks.prepare.mockResolvedValue({
    dir: "/box/verified",
    entry: "bundle.mjs",
  });
  mocks.run.mockResolvedValue(output([{ type: "SPEC", spec }]));
  mocks.withLease.mockImplementation(async (_request, fn) =>
    fn({
      ctx,
      fresh: true,
      markFailed: mocks.markFailed,
      markUnhealthy: mocks.markUnhealthy,
    }),
  );
});

describe("Calendly verified binding", () => {
  const release = { ...registry, slug: "calendly", ref: "mako/calendly@1.2.3" };
  const input = {
    workspaceId: "507f1f77bcf86cd799439011",
    connectionId: "507f1f77bcf86cd799439012",
    type: "calendly",
  };

  it("leaves the existing route untouched when no release is selected", async () => {
    mocks.resolveTrusted.mockResolvedValueOnce(null);
    await expect(bindCalendlyRelease(input)).resolves.toBeNull();
    expect(mocks.withLease).not.toHaveBeenCalled();
  });

  it("keeps the verified digest and spec together without credentials", async () => {
    mocks.resolveTrusted.mockResolvedValueOnce(release);
    const binding = await bindCalendlyRelease(input);
    expect(binding).toMatchObject({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      definition: { slug: "calendly", registry: release, spec },
    });
    expect(mocks.prepare).toHaveBeenCalledWith({
      ctx,
      runtimeId: "runtime",
      registry: release,
    });
    expect(mocks.withLease.mock.calls[0][0].bundleHash).toBe(release.sha256);
    expect(mocks.run.mock.calls[0][0]).not.toHaveProperty("input");
  });

  it("rejects an absent or mismatched artifact before a binding exists", async () => {
    mocks.resolveTrusted.mockRejectedValueOnce(new Error("digest mismatch"));
    await expect(bindCalendlyRelease(input)).rejects.toThrow("digest mismatch");
    expect(mocks.withLease).not.toHaveBeenCalled();
    mocks.resolveTrusted.mockResolvedValueOnce(release);
    mocks.prepare.mockRejectedValueOnce(new Error("missing artifact"));
    await expect(bindCalendlyRelease(input)).rejects.toThrow(
      "missing artifact",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("Stripe registry metadata", () => {
  it("runs the resolved bundle without inputs on a unique one-off box", async () => {
    const result = await loadStripeRegistryMetadata({ workspaceId: "ws", pin });
    expect(result).toEqual({ registry, entry: "bundle.mjs", spec });
    expect(mocks.resolve).toHaveBeenCalledWith(pin, undefined);
    expect(mocks.prepare).toHaveBeenCalledWith({
      ctx,
      runtimeId: "runtime",
      registry,
    });
    expect(mocks.run).toHaveBeenCalledWith({
      ctx,
      runtimeId: "runtime",
      connectorDir: "/box/verified",
      entry: "bundle.mjs",
      command: "spec",
      timeoutMs: 60_000,
      onCleanupFailure: expect.any(Function),
    });
    const request = mocks.withLease.mock.calls[0][0];
    expect(request).toMatchObject({
      workspaceId: "ws",
      bundleHash: registry.sha256,
      command: "spec",
      oneOff: true,
    });
    expect(request).not.toHaveProperty("runtimeId");
    await loadStripeRegistryMetadata({ workspaceId: "ws", pin });
    expect(mocks.withLease.mock.calls[1][0].connectionId).not.toBe(
      request.connectionId,
    );
  });

  it("refuses missing pins and resolution failures before leasing", async () => {
    mocks.resolve
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("digest mismatch"));
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin: {} }),
    ).rejects.toThrow("pin is missing");
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow("digest mismatch");
    expect(mocks.withLease).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    ["invalid", [{ type: "SPEC", spec: { connectionSpecification: {} } }]],
  ])("refuses %s SPEC", async (_name, messages) => {
    mocks.run.mockResolvedValue(output(messages));
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow();
  });

  it("refuses failed and timed-out commands", async () => {
    mocks.run.mockResolvedValueOnce(
      output([{ type: "SPEC", spec }], { exitCode: 1 }),
    );
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow("code 1");
    mocks.run.mockResolvedValueOnce(output([], { timedOut: true }));
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow("timed out");
    expect(mocks.markFailed).toHaveBeenCalledWith("timed out");
  });

  it("refuses an installation failure and a reused box", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("bad bundle"));
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow("bad bundle");
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.withLease.mockImplementationOnce(async (_request, fn) =>
      fn({ ctx, fresh: false }),
    );
    await expect(
      loadStripeRegistryMetadata({ workspaceId: "ws", pin }),
    ).rejects.toThrow("fresh box");
  });
});
