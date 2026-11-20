/**
 * A source connection whose connector type was removed (no config schema).
 *
 * Its stored config cannot be edited (a new secret would be stored in
 * plaintext), decrypted or sent (ciphertext would go out as a credential).
 * Name, description and DELETE still work. The type is generic: any name the
 * registry has no schema for.
 *
 * Real routes and proxy, real Mongo (mongodb-memory-server); auth and the
 * connector schema are mocked; the HTTP transport is a spy that must stay
 * unused.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "owner1" });
    c.set("authType", "session");
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "owner" })),
    getOwnerIds: vi.fn(async () => ["owner1"]),
  },
}));

// "gcs" and "wise" have no schema here (removed connectors); "close" does.
vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async (type: string) =>
      type === "close"
        ? { fields: [{ name: "api_key", type: "password", encrypted: true }] }
        : null,
    ),
    getConnectorFor: vi.fn(async () => null),
  },
}));

vi.mock("../connectors/registry", () => ({
  connectorRegistry: { hasConnector: vi.fn(() => true) },
}));

import { sourceConnectionRoutes } from "./source-connections";
import { SourceConnection } from "../database/workspace-schema";
import { applySchemaEncryption } from "../connectors/source-connection-create.service";
import { connectionRequest } from "../connections/proxy.service";
import { setTransportForTests } from "../connections/forward";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const CIPHERTEXT = "00112233445566778899aabbccddeeff:deadbeef";

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<TestResponse> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/connections/sources${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

const transport = vi.fn();

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  setTransportForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
});

let orphan: string;
beforeEach(async () => {
  transport.mockReset();
  setTransportForTests(transport);
  await SourceConnection.deleteMany({});
  orphan = String(
    (
      await SourceConnection.create({
        workspaceId: WS,
        name: "old gcs",
        type: "gcs",
        config: { api_key: CIPHERTEXT, bucket: "b" },
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
        liveReads: true,
        createdBy: "owner1",
        managers: ["owner1"],
      })
    )._id,
  );
});

const stored = async () => await SourceConnection.findById(orphan).lean();

describe("an orphan type (no config schema)", () => {
  it("refuses a new secret and leaves the row untouched", async () => {
    const before = await stored();
    const res = await req("PUT", `/${orphan}`, {
      config: { api_key: "sk_live_plaintext" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer available/);
    expect(await stored()).toEqual(before);
  });

  it("refuses a changed plain field, settings, targets and switching on", async () => {
    const before = await stored();
    for (const body of [
      { config: { bucket: "other" } },
      { settings: { sync_batch_size: 5 } },
      { targetDatabases: [String(new Types.ObjectId())] },
      { isActive: true, type: "gcs2" },
      { type: "close" },
    ]) {
      const res = await req("PUT", `/${orphan}`, body);
      expect(res.status).toBe(409);
    }
    expect(await stored()).toEqual(before);
  });

  it("renames and re-describes", async () => {
    const res = await req("PUT", `/${orphan}`, {
      name: "retired gcs",
      description: "kept for the record",
    });
    expect(res.status).toBe(200);
    const row = await stored();
    expect(row?.name).toBe("retired gcs");
    expect(row?.description).toBe("kept for the record");
    expect((row?.config as Record<string, string>).api_key).toBe(CIPHERTEXT);
  });

  it("deletes", async () => {
    const res = await req("DELETE", `/${orphan}`);
    expect(res.status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it("call_connection is refused before any HTTP request", async () => {
    await expect(
      connectionRequest({
        workspaceId: String(WS),
        connection: orphan,
        request: { method: "GET", path: "/" },
        actor: { userId: "owner1" },
      } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("the encryption helper throws instead of passing a config through", () => {
    expect(() => applySchemaEncryption({ api_key: "x" }, null)).toThrow(
      /no longer available/,
    );
    expect(applySchemaEncryption({}, null)).toEqual({});
  });
});
