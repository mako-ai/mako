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
