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
import { syncConnectorRegistry } from "../sync/connector-registry";

const defaultSchema = {
  fields: [
    { name: "api_key", type: "password", encrypted: true },
    { name: "account", type: "string" },
  ],
};

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
  vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
    defaultSchema,
  );
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

  it("GET still withholds ciphertext when the connector schema is missing", async () => {
    // GraphQL/REST store auth headers in a field named `headers`. That name
    // does not match the database-connection secret-key regex, so redaction
    // that only walks the schema (or only those names) fails open if the
    // schema cannot be loaded — a deleted workspace connector, a registry
    // blip. Ciphertext is still a credential.
    vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
      null,
    );
    const ciphertext = encryptString(SECRET);
    const row = await Connector.create({
      workspaceId: new Types.ObjectId(WS),
      name: "Hasura",
      type: "graphql",
      config: { headers: ciphertext, endpoint: "https://api.example.com" },
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

    const res = await req("GET", `/${row._id.toString()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { config: Record<string, unknown> };
    };
    expect(body.data.config.endpoint).toBe("https://api.example.com");
    expect(body.data.config.headers).toBe(SECRET_KEPT);
    expect(JSON.stringify(body)).not.toContain(ciphertext);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("GET still answers 200 when schema lookup throws", async () => {
    vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockRejectedValue(
      new Error("registry down"),
    );
    const { id, ciphertext } = await seed();
    const res = await req("GET", `/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { config: Record<string, unknown> };
    };
    expect(body.data.config.api_key).toBe(SECRET_KEPT);
    expect(JSON.stringify(body)).not.toContain(ciphertext);
  });
  // The edit form gets {@link SECRET_KEPT} inside object_array items too
  // (applySecretPlaceholders recurses). A kept item secret is restored from
  // the stored item with the same non-secret fields — never by position,
  // because the form can remove or reorder items.
  describe("SECRET_KEPT inside array items", () => {
    const nested = {
      fields: [
        {
          name: "accounts",
          type: "object_array",
          itemFields: [
            { name: "label", type: "string" },
            { name: "token", type: "password" },
          ],
        },
      ],
    };
    let euCipher = "";
    let usCipher = "";

    async function seedAccounts(): Promise<string> {
      vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
        nested,
      );
      euCipher = encryptString("tok_eu_" + SECRET);
      usCipher = encryptString("tok_us_" + SECRET);
      const row = await Connector.create({
        workspaceId: new Types.ObjectId(WS),
        name: "REST",
        type: "rest",
        config: {
          accounts: [
            { label: "eu", token: euCipher },
            { label: "us", token: usCipher },
          ],
        },
        isActive: true,
        createdBy: "u1",
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      });
      return row._id.toString();
    }

    async function storedAccounts(id: string) {
      const stored = (await Connector.findById(id).lean()) as {
        name: string;
        config: { accounts: Array<Record<string, string>> };
      };
      return stored;
    }

    it("after remove(0), the remaining item keeps its OWN secret", async () => {
      const id = await seedAccounts();
      const read = (await (await req("GET", `/${id}`)).json()) as {
        data: { config: { accounts: Array<Record<string, unknown>> } };
      };
      expect(read.data.config.accounts[1].token).toBe(SECRET_KEPT);

      const res = await req("PUT", `/${id}`, {
        config: { accounts: [{ label: "us", token: SECRET_KEPT }] },
      });
      expect(res.status).toBe(200);
      const stored = await storedAccounts(id);
      expect(stored.config.accounts).toEqual([
        { label: "us", token: usCipher },
      ]);
    });

    it("a reorder keeps each item's secret", async () => {
      const id = await seedAccounts();
      const res = await req("PUT", `/${id}`, {
        config: {
          accounts: [
            { label: "us", token: SECRET_KEPT },
            { label: "eu", token: SECRET_KEPT },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect((await storedAccounts(id)).config.accounts).toEqual([
        { label: "us", token: usCipher },
        { label: "eu", token: euCipher },
      ]);
    });

    it("an unmatched sentinel is a 400 naming the path, and nothing is saved", async () => {
      const id = await seedAccounts();
      const res = await req("PUT", `/${id}`, {
        name: "renamed too",
        config: {
          accounts: [
            { label: "us", token: SECRET_KEPT },
            { label: "new", token: SECRET_KEPT },
          ],
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        unresolved: string[];
      };
      expect(body.unresolved).toEqual(["accounts[1].token"]);
      expect(body.error).toContain("accounts[1].token");
      expect(JSON.stringify(body)).not.toContain(SECRET);
      const stored = await storedAccounts(id);
      expect(stored.name).toBe("REST");
      expect(stored.config.accounts).toHaveLength(2);
      expect(JSON.stringify(stored)).not.toContain(SECRET_KEPT);
    });
  });

  describe("the edit form's real shape", () => {
    const formSchema = {
      fields: [
        {
          name: "accounts",
          type: "object_array",
          itemFields: [
            { name: "region", type: "string" },
            { name: "label", type: "string" },
            { name: "token", type: "password" },
          ],
        },
      ],
    };

    async function seedOne(): Promise<{ id: string; cipher: string }> {
      vi.mocked(syncConnectorRegistry.getConfigSchemaForType).mockResolvedValue(
        formSchema,
      );
      const cipher = encryptString("AAA_" + SECRET);
      const row = await Connector.create({
        workspaceId: new Types.ObjectId(WS),
        name: "REST",
        type: "rest",
        config: { accounts: [{ region: "eu", token: cipher }] },
        isActive: true,
        createdBy: "u1",
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      });
      return { id: row._id.toString(), cipher };
    }

    it("an unchanged item sent with empty optional fields keeps its secret (200)", async () => {
      const { id, cipher } = await seedOne();
      const res = await req("PUT", `/${id}`, {
        config: {
          accounts: [{ region: "eu", label: "", token: SECRET_KEPT }],
        },
      });
      expect(res.status).toBe(200);
      const stored = (await Connector.findById(id).lean()) as {
        config: { accounts: Array<Record<string, string>> };
      };
      expect(stored.config.accounts[0].token).toBe(cipher);
    });

    it("an omitted, unmatched item secret saves as before, with a warning", async () => {
      const { id, cipher } = await seedOne();
      const res = await req("PUT", `/${id}`, {
        config: {
          accounts: [
            { region: "eu", label: "", token: SECRET_KEPT },
            { region: "us", label: "" },
          ],
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings?: string[] };
      expect(body.warnings).toEqual([
        expect.stringMatching(/^accounts\[1\]\.token: no value sent/),
      ]);
      const stored = (await Connector.findById(id).lean()) as {
        config: { accounts: Array<Record<string, string>> };
      };
      expect(stored.config.accounts).toEqual([
        { region: "eu", label: "", token: cipher },
        { region: "us", label: "" },
      ]);
    });

    it("a normal PUT carries no warnings", async () => {
      const { id } = await seedOne();
      const res = await req("PUT", `/${id}`, {
        config: { accounts: [{ region: "eu", token: "new-token" }] },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { warnings?: string[] }).warnings).toBe(
        undefined,
      );
    });
  });

  it("PUT with a top-level SECRET_KEPT over an absent secret is a 400", async () => {
    const row = await Connector.create({
      workspaceId: new Types.ObjectId(WS),
      name: "Stripe",
      type: "stripe",
      config: { account: "acct_1" },
      isActive: true,
      createdBy: "u1",
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    });
    const res = await req("PUT", `/${row._id.toString()}`, {
      config: { api_key: SECRET_KEPT },
    });
    expect(res.status).toBe(400);
    const stored = (await Connector.findById(row._id).lean()) as {
      config: Record<string, unknown>;
    };
    expect(stored.config).toEqual({ account: "acct_1" });
  });

  it("POST with SECRET_KEPT anywhere in the config is refused, not stored", async () => {
    const res = await req("POST", "", {
      name: "Stripe",
      type: "stripe",
      config: { api_key: SECRET_KEPT },
    });
    expect(res.status).toBe(400);
    expect(await Connector.countDocuments({})).toBe(0);
  });
});
