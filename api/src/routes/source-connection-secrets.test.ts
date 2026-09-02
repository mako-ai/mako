/**
 * Source-connection credentials are write-only, like database connections.
 *
 * GET / list / create / update / enable used to return `config` as stored —
 * which for secret fields is AES ciphertext (`iv:hex`). That is still a
 * credential: every workspace member could harvest it, and the edit form
 * loaded it into the password field. Database connections already substitute
 * {@link SECRET_KEPT} and restore it on write. These specs pin the same bar.
 *
 * Real routes + real Mongo (mongodb-memory-server); auth, workspace access,
 * and the connector schema are mocked.
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
    c.set("user", { id: "u1" });
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "member" })),
    isAdmin: vi.fn(async () => false),
  },
}));

vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async () => ({
      fields: [
        { name: "api_key", type: "password", encrypted: true },
        { name: "account", type: "string" },
      ],
    })),
    getConnectorFor: vi.fn(async () => null),
  },
}));

vi.mock("../connectors/registry", () => ({
  connectorRegistry: {
    hasConnector: vi.fn(() => true),
  },
}));

import { sourceConnectionRoutes } from "./source-connections";
import { Connector } from "../database/workspace-schema";
import { encryptString } from "../services/crypto.service";
import { SECRET_KEPT } from "../utils/connection-secrets";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const SECRET = "sk_live_do_not_leak_this_key";

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function req(method: string, path: string, body?: unknown): Promise<Response> {
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

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Connector.deleteMany({});
});

async function seed() {
  const ciphertext = encryptString(SECRET);
  const row = await Connector.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Stripe",
    type: "stripe",
    config: { api_key: ciphertext, account: "acct_123" },
    isActive: true,
    createdBy: "u1",
    settings: {
      sync_batch_size: 100,
      rate_limit_delay_ms: 200,
      max_retries: 3,
      timeout_ms: 30000,
      timezone: "UTC",
    },
  });
  return { row, ciphertext, id: row._id.toString() };
}

function assertConfigRedacted(
  config: Record<string, unknown>,
  ciphertext: string,
) {
  expect(config.account).toBe("acct_123");
  expect(config.api_key).toBe(SECRET_KEPT);
  expect(config.api_key).not.toBe(ciphertext);
  expect(config.api_key).not.toBe(SECRET);
}

describe("source-connection reads never return a credential", () => {
  it("GET /:id substitutes SECRET_KEPT for secret fields", async () => {
    const { id, ciphertext } = await seed();
    const res = await req("GET", `/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { config: Record<string, unknown> };
    };
    expect(body.success).toBe(true);
    assertConfigRedacted(body.data.config, ciphertext);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(ciphertext);
  });

  it("GET / (list) redacts every row, including for a mere member", async () => {
    const { ciphertext } = await seed();
    const res = await req("GET", "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ config: Record<string, unknown> }>;
    };
    expect(body.data).toHaveLength(1);
    assertConfigRedacted(body.data[0].config, ciphertext);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(ciphertext);
  });

  it("PUT echoing SECRET_KEPT leaves the stored secret intact", async () => {
    const { id, ciphertext } = await seed();
    const res = await req("PUT", `/${id}`, {
      config: { api_key: SECRET_KEPT, account: "acct_456" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { config: Record<string, unknown> };
    };
    expect(body.data.config.account).toBe("acct_456");
    expect(body.data.config.api_key).toBe(SECRET_KEPT);
    expect(JSON.stringify(body)).not.toContain(ciphertext);

    const stored = await Connector.findById(id).lean();
    expect(
      (stored as { config: { api_key: string; account: string } }).config
        .api_key,
    ).toBe(ciphertext);
    expect(
      (stored as { config: { api_key: string; account: string } }).config
        .account,
    ).toBe("acct_456");
  });

  it("POST records the authenticated user as createdBy, not 'system'", async () => {
    const res = await req("POST", "", {
      name: "Stripe",
      type: "stripe",
      config: { api_key: SECRET, account: "acct_123" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { _id: string; config: Record<string, unknown> };
    };
    expect(body.success).toBe(true);
    expect(body.data.config.api_key).toBe(SECRET_KEPT);
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const stored = await Connector.findById(body.data._id).lean();
    expect((stored as { createdBy: string }).createdBy).toBe("u1");
    expect((stored as { createdBy: string }).createdBy).not.toBe("system");
  });
});
