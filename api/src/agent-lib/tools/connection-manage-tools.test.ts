/**
 * Managing a source connection over MCP: reading its plain settings and
 * access (inspect_connection), changing it (update_connection), removing it
 * (delete_connection), and what create_connection says about access.
 *
 * SECRETS — no secret value comes back from any of them, and none can be
 * changed: the assertions are made against the serialized results.
 *
 * PERMISSIONS — the same people as the app's PUT / DELETE routes: one of the
 * connection's managers, or the workspace owner; never a viewer. What the
 * routes keep to a person in the app (where the key is sent, the Access tab)
 * is refused.
 *
 * RENAMES — a rename succeeds and warns that references by name break.
 *
 * PGlite holds connections and access. The source deletion guard reads ingestion flows in MongoDB.
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
import mongoose, { Types } from "mongoose";
import {
  type PgTestDb,
  setupPgTestDb,
  ensureTestWorkspace,
  ensureTestMember,
  ensureTestSourceConnection,
} from "../../test-support/pg-test";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connectors/probe.service")>();
  return {
    ...actual,
    probeConnection: vi.fn(async () => ({
      check: { success: true, message: "ok" },
    })),
  };
});

import { Flow } from "../../database/workspace-schema";
import { legacyUserIdToUuidv7 } from "../../database/pg/id-codec";
import { hashKeyToken } from "../../connectors/connection-key-request.service";
import { connectionsRepo } from "../../repositories/connections";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { encryptString } from "../../services/crypto.service";
import { createConnectorTools, nonSecretConfig } from "./connector-tools";
import {
  configUpdateProblem,
  createConnectionWriteTools,
} from "./connection-write-tools";

const SECRET = "tok_do_not_leak_0123456789";
const HEADER_SECRET = "Bearer hdr_do_not_leak";

type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};

const OWNER = legacyUserIdToUuidv7("owner1");
const MANAGER = legacyUserIdToUuidv7("manager1");
const MEMBER = legacyUserIdToUuidv7("member2");
const VIEWER = legacyUserIdToUuidv7("viewer1");

let mongo: MongoMemoryServer;
let pg: PgTestDb;
let WS: string;
let API: Types.ObjectId;

const inspect = () =>
  (createConnectorTools(WS) as unknown as Record<string, Executable>)
    .inspect_connection;
const writeTools = (userId: string) =>
  createConnectionWriteTools(WS, userId) as unknown as Record<
    string,
    Executable
  >;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??=
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await pg?.close();
});

beforeEach(async () => {
  await pg.reset();
  await Flow.collection.deleteMany({});
  WS = new Types.ObjectId().toString();
  await ensureTestWorkspace(pg.db, { id: WS });
  for (const [userId, role] of [
    [OWNER, "owner"],
    [MANAGER, "member"],
    [MEMBER, "member"],
    [VIEWER, "viewer"],
  ] as const) {
    await ensureTestMember(pg.db, {
      workspaceId: WS,
      userId,
      role,
    });
  }
  API = new Types.ObjectId();
  await connectionsRepo.createSourceConnection({
    id: String(API),
    workspaceId: WS,
    name: "inbox",
    type: "custom_api",
    config: {
      base_url: "https://api.sendgrid.com/v3",
      auth_type: "bearer",
      token: encryptString(SECRET),
      extra_headers: HEADER_SECRET,
    },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: MANAGER,
    managers: [MANAGER],
    liveReads: true,
    writers: [
      { principal: "workflow:send-digest" },
      { principal: `user:${MANAGER}` },
    ],
  });
});

describe("inspect_connection: plain settings and access, never a secret", () => {
  it("returns base_url, auth_type, which secrets are set, and the access settings", async () => {
    const result = await inspect().execute({ connectionId: API.toString() });
    expect(result.kind).toBe("source");
    const config = result.config as Record<string, unknown>;
    expect(config.base_url).toBe("https://api.sendgrid.com/v3");
    expect(config.auth_type).toBe("bearer");
    expect(config).not.toHaveProperty("token");
    expect(config).not.toHaveProperty("extra_headers");
    expect(result.secretsSet).toContain("token");
    expect(result.access).toMatchObject({
      liveReads: true,
      writers: ["workflow:send-digest", `user:${MANAGER}`],
      callable: true,
    });
    expect(String((result.access as { changeIn: string }).changeIn)).toContain(
      `/cx/${API.toString()}`,
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hdr_do_not_leak");
  });

  it("an older connection with no access fields reads as live reads off, no writers", async () => {
    const legacy = await ensureTestSourceConnection(pg.db, {
      workspaceId: WS,
      name: "legacy",
      type: "custom_api",
      createdBy: MANAGER,
    });
    const result = await inspect().execute({ connectionId: legacy.id });
    expect(result.access).toMatchObject({ liveReads: false, writers: [] });
  });

  it("nonSecretConfig fails closed", () => {
    const fields = [
      { name: "base_url", type: "string", required: true, secret: false },
      { name: "token", type: "password", required: true, secret: true },
      { name: "client_secret", type: "string", required: false, secret: false },
      { name: "headers", type: "string", required: false, secret: false },
      { name: "nested", type: "object", required: false, secret: false },
      { name: "cipher", type: "string", required: false, secret: false },
      { name: "page_size", type: "number", required: false, secret: false },
    ];
    expect(
      nonSecretConfig(
        {
          base_url: "https://user:pw_leak@example.com/v1",
          token: "t",
          client_secret: "s",
          headers: "Authorization: x",
          nested: { a: 1 },
          cipher: encryptString("c"),
          page_size: 50,
          undeclared: "u",
        },
        fields,
      ),
    ).toEqual({ page_size: 50 });
  });
});

describe("update_connection", () => {
  it("renames, and warns that references by name break", async () => {
    const result = await writeTools(MANAGER).update_connection.execute({
      connectionId: API.toString(),
      name: "sendgrid",
    });
    expect(result.error).toBeUndefined();
    expect(result.renamed).toEqual({ from: "inbox", to: "sendgrid" });
    expect(String(result.warning)).toContain('connection("inbox")');
    expect(String(result.warning)).toContain(API.toString());
    const stored = await connectionsRepo.findSourceConnectionById(
      String(API),
      WS,
    );
    expect(stored?.name).toBe("sendgrid");
  });

  it("accepts a current name as the reference", async () => {
    const result = await writeTools(OWNER).update_connection.execute({
      connectionId: "inbox",
      description: "SendGrid for digests",
    });
    expect(result.changed).toEqual(["description"]);
  });

  it("refuses a name another source connection holds", async () => {
    await connectionsRepo.createSourceConnection({
      workspaceId: WS,
      name: "taken",
      type: "stripe",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: MANAGER,
    });
    const result = await writeTools(MANAGER).update_connection.execute({
      connectionId: API.toString(),
      name: "taken",
    });
    expect(String(result.error)).toMatch(/already exists/);
  });

  it("refuses secrets, where the key is sent, and unknown fields, without touching the row", async () => {
    const before = JSON.stringify(
      await connectionsRepo.findSourceConnectionById(String(API), WS),
    );
    for (const config of [
      { token: "new_secret_value" },
      { base_url: "https://evil.example.com" },
      { auth_type: "none" },
      { extra_headers: "X: y" },
      { not_a_field: "x" },
    ]) {
      const result = await writeTools(MANAGER).update_connection.execute({
        connectionId: API.toString(),
        config,
      });
      expect(result.error, JSON.stringify(config)).toBeTruthy();
      expect(String(result.error)).not.toContain("new_secret_value");
    }
    expect(
      JSON.stringify(
        await connectionsRepo.findSourceConnectionById(String(API), WS),
      ),
    ).toBe(before);
  });

  it("refuses an orphaned graphql connection, any address-like field, and a field holding a URL", async () => {
    const gqlId = new Types.ObjectId().toString();
    // GraphQL stored headers as an encrypted string. Its connector has
    // been removed, so an edit of the orphaned row fails closed.
    await connectionsRepo.createSourceConnection({
      id: gqlId,
      workspaceId: WS,
      name: "gql",
      type: "graphql",
      config: {
        endpoint: "https://api.example.com/graphql",
        headers: encryptString('{"Authorization":"Bearer x"}'),
      },
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: MANAGER,
      managers: [MANAGER],
      isActive: true,
    });
    const endpoint = await writeTools(MANAGER).update_connection.execute({
      connectionId: gqlId,
      config: { endpoint: "https://attacker.example/x" },
    });
    // The refusal is configUpdateProblem's no-schema guard.
    expect(String(endpoint.error)).toMatch(/declares no config schema/);
    expect(String(endpoint.error)).not.toContain("attacker.example");
    expect(
      (await connectionsRepo.findSourceConnectionById(gqlId, WS))?.config
        ?.endpoint,
    ).toBe("https://api.example.com/graphql");

    const schema = {
      fields: [
        { name: "api_base_url", type: "string" },
        { name: "endpoint", type: "string" },
        { name: "tenant_host", type: "string" },
        { name: "label", type: "string" },
        { name: "page_size", type: "number" },
      ],
    };
    for (const [config, stored] of [
      [{ api_base_url: "x" }, {}],
      [{ endpoint: "x" }, {}],
      [{ tenant_host: "x" }, {}],
      [{ label: "https://attacker.example" }, {}],
      [{ label: "attacker.example.com" }, {}],
      [{ label: "plain" }, { label: "https://api.vendor.com" }],
    ] as const) {
      expect(
        configUpdateProblem({ ...config }, schema, "ws:any", { ...stored }),
        JSON.stringify(config),
      ).toMatch(/only in the app/);
    }
    expect(
      configUpdateProblem(
        { label: "Finance", page_size: 1.5 },
        schema,
        "ws:any",
      ),
    ).toBeNull();
  });

  it("reads a 12-character name as a name, and refuses a name several connections share", async () => {
    await connectionsRepo.updateSourceConnection(String(API), WS, {
      name: "stripe_prod1",
    });
    const byName = await writeTools(MANAGER).update_connection.execute({
      connectionId: "stripe_prod1",
      description: "d",
    });
    expect(byName.error).toBeUndefined();
    expect(byName.connectionId).toBe(API.toString());

    await connectionsRepo.createSourceConnection({
      workspaceId: WS,
      name: "stripe_prod1",
      type: "stripe",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: MANAGER,
    });
    for (const call of [
      writeTools(MANAGER).update_connection.execute({
        connectionId: "stripe_prod1",
        description: "e",
      }),
      writeTools(MANAGER).delete_connection.execute({
        connectionId: "stripe_prod1",
        confirmName: "stripe_prod1",
      }),
    ]) {
      expect(String((await call).error)).toMatch(/Several source connections/);
    }
    expect(
      (await connectionsRepo.listSourceConnections(WS)).filter(
        row => row.name === "stripe_prod1",
      ).length,
    ).toBe(2);
  });

  it("only the connection's managers and the workspace owner may change it", async () => {
    const member = await writeTools(MEMBER).update_connection.execute({
      connectionId: API.toString(),
      name: "x",
    });
    expect(String(member.error)).toMatch(/managers/);
    const viewer = await writeTools(VIEWER).update_connection.execute({
      connectionId: API.toString(),
      name: "x",
    });
    expect(String(viewer.error)).toMatch(/member role/);
    const stranger = await writeTools("nobody").update_connection.execute({
      connectionId: API.toString(),
      name: "x",
    });
    expect(String(stranger.error)).toMatch(/no longer a member/);
    expect(
      (await connectionsRepo.findSourceConnectionById(String(API), WS))?.name,
    ).toBe("inbox");
  });

  it("never finds another workspace's connection", async () => {
    const other = await ensureTestWorkspace(pg.db);
    const theirs = await connectionsRepo.createSourceConnection({
      workspaceId: other.id,
      name: "theirs",
      type: "stripe",
      config: {},
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: MANAGER,
    });
    const result = await writeTools(OWNER).update_connection.execute({
      connectionId: String(theirs._id),
      name: "mine",
    });
    expect(String(result.error)).toMatch(/not found/);
  });

  it("configUpdateProblem refuses a connector without a schema", () => {
    expect(configUpdateProblem({ a: "b" }, null, "x")).toMatch(
      /no config schema/,
    );
  });

  it("patches only changed config keys so a concurrently claimed key-link secret is not erased", async () => {
    const token = "one-time-link-token-concurrent";
    const tokenHash = hashKeyToken(token);
    const pendingId = new Types.ObjectId();
    await connectionsRepo.createSourceConnection({
      id: String(pendingId),
      workspaceId: WS,
      name: "crm-pending",
      type: "acme_crm",
      config: { account_id: "acct_old" },
      isActive: false,
      settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
      createdBy: MANAGER,
      managers: [MANAGER],
      keyRequest: {
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
        fields: ["api_key"],
        requestedBy: MANAGER,
        createdAt: new Date(),
      },
    });

    const claimedCiphertext = encryptString("sk_claimed_during_update");
    const schemaSpy = vi
      .spyOn(syncConnectorRegistry, "getConfigSchemaForType")
      .mockImplementationOnce(async () => {
        // Simulate the user submitting the key link AFTER update_connection
        // loaded `row` and BEFORE updateSourceConnection runs.
        const claimed = await connectionsRepo.claimSourceConnectionKeyRequest({
          id: pendingId.toString(),
          workspaceId: WS,
          tokenHash,
          encryptedFields: { api_key: claimedCiphertext },
        });
        expect(claimed).toBe(true);
        return {
          fields: [
            { name: "account_id", label: "Account ID", type: "string" },
            {
              name: "api_key",
              label: "API Key",
              type: "password",
              required: true,
            },
          ],
        };
      });

    try {
      const result = await writeTools(MANAGER).update_connection.execute({
        connectionId: pendingId.toString(),
        config: { account_id: "acct_new" },
      });
      expect(result.error).toBeUndefined();
      expect(result.changed).toContain("config.account_id");

      const stored = await connectionsRepo.findSourceConnectionById(
        String(pendingId),
        WS,
      );
      expect(stored?.isActive).toBe(true);
      expect(stored?.keyRequest).toBeUndefined();
      expect(stored?.config).toEqual({
        account_id: "acct_new",
        api_key: claimedCiphertext,
      });
    } finally {
      schemaSpy.mockRestore();
    }
  });
});

describe("delete_connection", () => {
  it("needs the current name, and refuses while a flow syncs from it", async () => {
    const wrong = await writeTools(MANAGER).delete_connection.execute({
      connectionId: API.toString(),
      confirmName: "other",
    });
    expect(String(wrong.error)).toMatch(/does not match/);

    await Flow.collection.insertOne({
      workspaceId: new Types.ObjectId(WS),
      name: "sendgrid-events",
      dataSourceId: API,
    });
    const used = await writeTools(MANAGER).delete_connection.execute({
      connectionId: API.toString(),
      confirmName: "inbox",
    });
    expect(String(used.error)).toMatch(/sendgrid-events/);
    expect(
      await connectionsRepo.findSourceConnectionById(String(API), WS),
    ).toBeTruthy();
  });

  it("only a manager or the owner deletes it", async () => {
    const member = await writeTools(MEMBER).delete_connection.execute({
      connectionId: API.toString(),
      confirmName: "inbox",
    });
    expect(String(member.error)).toMatch(/managers/);
    const owner = await writeTools(OWNER).delete_connection.execute({
      connectionId: API.toString(),
      confirmName: "inbox",
    });
    expect(owner).toMatchObject({ deleted: true, name: "inbox" });
    expect(
      await connectionsRepo.findSourceConnectionById(String(API), WS),
    ).toBeNull();
  });
});

describe("create_connection reports access", () => {
  it("a new connection starts with live reads off and no writers, and links to the Access tab", async () => {
    const result = await writeTools(MEMBER).create_connection.execute({
      connector: "custom_api",
      name: "new_api",
      config: {
        base_url: "https://api.example.com",
        auth_type: "bearer",
        token: SECRET,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.access).toMatchObject({ liveReads: false, writers: [] });
    expect(String((result.access as { changeIn: string }).changeIn)).toMatch(
      /\/cx\/[0-9a-f]{24}, Access tab/,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
