import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  decrypt: vi.fn(() => "decrypted"),
}));
vi.mock("../../../services/database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({
      db: { collection: () => ({ findOne: mocks.findOne }) },
    }),
  },
}));
vi.mock("../../../services/crypto.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../../services/crypto.service")
  >()),
  decryptEncrypted: mocks.decrypt,
}));
vi.mock("../../../sync/connector-registry", () => ({
  syncConnectorRegistry: {},
}));

import { SourceConnectionManager } from "../../../sync/database-data-source-manager";
import { LaunchDeadlineError } from "../../../apps/sandbox/launch-deadline";
import type { CalendlyBinding } from "../registry/calendly-binding";

const previousUrl = process.env.DATABASE_URL;
afterAll(() => {
  if (previousUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousUrl;
});

const workspaceId = new ObjectId().toString();
const connectionId = new ObjectId().toString();
const binding = {
  workspaceId,
  connectionId,
  schema: { fields: [{ name: "token", type: "password", label: "Token" }] },
} as CalendlyBinding;

describe("verified Calendly credential reload", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "mongodb://127.0.0.1/test";
    vi.clearAllMocks();
    mocks.findOne.mockResolvedValue({
      _id: new ObjectId(connectionId),
      workspaceId: new ObjectId(workspaceId),
      type: "calendly",
      config: { token: "encrypted:value" },
    });
  });

  it("uses the selected identity and verified schema", async () => {
    const result =
      await new SourceConnectionManager().getBoundCalendlyConnection(binding);
    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: new ObjectId(connectionId),
      workspaceId: new ObjectId(workspaceId),
      type: "calendly",
    });
    expect(mocks.decrypt).toHaveBeenCalledWith("encrypted:value");
    expect(result?.connection.token).toBe("decrypted");
  });

  it("stops before querying when the probe budget is exhausted", async () => {
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection({
        ...binding,
        remainingMs: () => 0,
      }),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("stops before decryption when the database lookup exhausts the budget", async () => {
    const remainingMs = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValue(0);
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection({
        ...binding,
        remainingMs,
      }),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(mocks.findOne).toHaveBeenCalledTimes(1);
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("stops before querying when database acquisition exhausts the budget", async () => {
    const remainingMs = vi.fn().mockReturnValueOnce(100).mockReturnValue(0);
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection({
        ...binding,
        remainingMs,
      }),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("authorizes the exact scoped row without exposing its credential", async () => {
    mocks.findOne.mockResolvedValueOnce({
      _id: new ObjectId(connectionId),
      workspaceId: new ObjectId(workspaceId),
      type: "calendly",
      name: "Saved Calendly",
      liveReads: false,
      config: { token: "encrypted:value" },
    });
    const authorize = vi.fn().mockRejectedValueOnce(new Error("revoked"));
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection(
        binding,
        authorize,
      ),
    ).rejects.toThrow("revoked");
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize.mock.calls[0][0]).toMatchObject({
      name: "Saved Calendly",
      liveReads: false,
    });
    expect(authorize.mock.calls[0][0]).not.toHaveProperty("config");
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("checks the deadline again after authorization and before decryption", async () => {
    let remaining = 100;
    const authorize = vi.fn(async () => {
      remaining = 0;
    });
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection(
        { ...binding, remainingMs: () => remaining },
        authorize,
      ),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(authorize).toHaveBeenCalledOnce();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", { workspaceId: new ObjectId() }],
    ["id", { _id: new ObjectId() }],
    ["type", { type: "stripe" }],
  ])("refuses a changed %s before decrypting", async (_label, change) => {
    mocks.findOne.mockResolvedValue({
      _id: new ObjectId(connectionId),
      workspaceId: new ObjectId(workspaceId),
      type: "calendly",
      config: { token: "encrypted:value" },
      ...change,
    });
    await expect(
      new SourceConnectionManager().getBoundCalendlyConnection(binding),
    ).resolves.toBeNull();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
});
