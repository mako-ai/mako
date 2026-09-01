/**
 * The connector decrypt oracle, and the two vulnerabilities it carried.
 *
 * `POST /connectors/decrypt` took ciphertext from the request body and
 * returned its plaintext, gated only on workspace membership. Because
 * ENCRYPTION_KEY is global and the ciphertext was never bound to a
 * workspace, that gave (1) cross-tenant decryption — any member of any
 * workspace could decrypt ciphertext harvested from another tenant, a DB
 * dump or a backup — and (2) privilege escalation inside a workspace, since
 * a VIEWER could read credentials only admins may edit.
 *
 * These specs pin the replacement: the server reads the ciphertext from its
 * own record, addressed by connector id scoped to the URL workspace, and
 * only admins/owners may ask.
 *
 * Which specs are BEFORE/AFTER PROOFS and which are forward pins, stated
 * plainly so nobody mistakes one for the other:
 *   - the two `/decrypt` specs are real proofs: on the old handler that
 *     route answered 200 with the plaintext (for any member, and for a
 *     VIEWER), so they fail before the change and pass after it;
 *   - the reveal-secret specs (cross-workspace 404, viewer 403, owner 200,
 *     non-secret field 400) are forward pins: on the old code they fail
 *     only because the route did not exist, which proves nothing about the
 *     old behaviour. They exist to keep the NEW gates from regressing.
 *
 * Real routes + real Mongo (mongodb-memory-server); only auth, the
 * workspace service, and the connector registry are mocked.
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

const ctx = vi.hoisted(() => ({ role: "owner" as string | null }));

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
    hasAccess: vi.fn(async () => ctx.role !== null),
    getMember: vi.fn(async () => (ctx.role ? { role: ctx.role } : null)),
    isAdmin: vi.fn(async () => ctx.role === "owner" || ctx.role === "admin"),
  },
}));

// The connector's schema declares which config fields are secret.
vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async () => ({
      fields: [
        { name: "api_key", type: "password", encrypted: true },
        { name: "account", type: "string" },
      ],
    })),
  },
}));

import { dataSourceRoutes } from "./sources";
import { Connector } from "../database/workspace-schema";
import { encryptString } from "../services/crypto.service";

let mongo: MongoMemoryServer;
const WS_MINE = new Types.ObjectId().toString();
const WS_THEIRS = new Types.ObjectId().toString();
const SECRET = "sk_live_theirs_do_not_leak";

const app = new Hono();
app.route("/api/workspaces/:workspaceId/connectors", dataSourceRoutes);

function req(
  workspaceId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  // `app.request` is typed `Response | Promise<Response>`; await normalises it.
  return Promise.resolve(
    app.request(`/api/workspaces/${workspaceId}/connectors${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  ctx.role = "owner";
  await Connector.deleteMany({});
});

async function seedConnector(workspaceId: string) {
  return Connector.create({
    workspaceId: new Types.ObjectId(workspaceId),
    name: "Stripe",
    type: "stripe",
    config: { api_key: encryptString(SECRET), account: "acct_123" },
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
}

describe("the decryption oracle is gone", () => {
  it("there is no endpoint that decrypts caller-supplied ciphertext", async () => {
    // THE VULNERABILITY: this used to return the plaintext of any ciphertext
    // encrypted with the global key, from any tenant. It must not exist.
    const stolen = encryptString(SECRET);
    const res = await req(WS_MINE, "/decrypt", { encryptedValue: stolen });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
  });

  it("a VIEWER cannot decrypt caller-supplied ciphertext either", async () => {
    // THE SECOND VULNERABILITY: membership-only gating meant a viewer could
    // read credentials only admins may edit. On the old handler this
    // returned plaintext for a viewer; the endpoint must simply be gone.
    ctx.role = "viewer";
    const res = await req(WS_MINE, "/decrypt", {
      encryptedValue: encryptString(SECRET),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("a connector from ANOTHER workspace cannot be revealed", async () => {
    // Cross-tenant, now expressed the only way it still can be: name a
    // connector id that exists, from a workspace the caller is not in.
    const theirs = await seedConnector(WS_THEIRS);
    const res = await req(WS_MINE, `/${theirs._id.toString()}/reveal-secret`, {
      field: "api_key",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe("reveal-secret is admin/owner only", () => {
  it("a VIEWER is refused — membership is not enough", async () => {
    const mine = await seedConnector(WS_MINE);
    ctx.role = "viewer";
    const res = await req(WS_MINE, `/${mine._id.toString()}/reveal-secret`, {
      field: "api_key",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("an owner reveals their own connector's secret", async () => {
    const mine = await seedConnector(WS_MINE);
    const res = await req(WS_MINE, `/${mine._id.toString()}/reveal-secret`, {
      field: "api_key",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { value: string; wasEncrypted: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.data.value).toBe(SECRET);
    expect(body.data.wasEncrypted).toBe(true);
  });

  it("only fields the schema declares secret may be revealed", async () => {
    const mine = await seedConnector(WS_MINE);
    const res = await req(WS_MINE, `/${mine._id.toString()}/reveal-secret`, {
      field: "account",
    });
    expect(res.status).toBe(400);
  });
});
