/**
 * A source connection's credential is decrypted for, and run by, the
 * workspace connector definition it was saved under — by id, on the path
 * every sync, flow run, CDC step and probe takes (getSourceConnection →
 * getConnectorFor). A folder that later takes the same slug is a different
 * definition and must never receive it.
 *
 * Real in-memory Mongo; the main connection is the test's.
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
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../services/database-connection.service", () => ({
  databaseConnectionService: {
    getMainConnection: async () => ({
      db: (mongoose.connection as unknown as { db: unknown }).db,
    }),
  },
}));

import { ConnectorDefinition, Connector } from "../database/workspace-schema";
import { sourceConnectionManager } from "./database-data-source-manager";
import { syncConnectorRegistry } from "./connector-registry";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();

const spec = (secret: string) => ({
  connectionSpecification: {
    type: "object",
    properties: { [secret]: { type: "string", airbyte_secret: true } },
  },
});

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  // Read before the mocked main connection is used; any value will do.
  process.env.DATABASE_URL ??= "mongodb://unused/mako";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    ConnectorDefinition.deleteMany({}),
    Connector.deleteMany({}),
  ]);
});

async function definition(slug: string, sha: string, secret: string) {
  return ConnectorDefinition.create({
    workspaceId: WS,
    slug,
    sha,
    sourceSha: `s${sha}`,
    status: "indexed",
    entities: [],
    spec: spec(secret),
  });
}

async function connection(definitionId: Types.ObjectId | undefined) {
  return Connector.create({
    workspaceId: WS,
    name: "Acme",
    type: "ws:acme",
    ...(definitionId ? { connectorDefinitionId: definitionId } : {}),
    config: { apiKey: "plain" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
    isActive: true,
    createdBy: "u",
  });
}

describe("getSourceConnection honours the connector binding", () => {
  it("runs the definition the connection is bound to", async () => {
    const a = await definition("acme", "a", "apiKey");
    const conn = await connection(a._id);
    const ds = await sourceConnectionManager.getSourceConnection(
      conn._id.toString(),
    );
    expect(ds?.connectorDefinitionId).toBe(a._id.toString());
    const connector = (await syncConnectorRegistry.getConnectorFor(ds!)) as {
      definition: () => Promise<{ sha: string }>;
    };
    expect((await connector.definition()).sha).toBe("a");
  });

  it("fails closed when the bound definition is gone and another folder took its slug", async () => {
    const a = await definition("acme", "a", "apiKey");
    const conn = await connection(a._id);
    await ConnectorDefinition.deleteOne({ _id: a._id });
    await definition("acme", "b", "otherKey");
    // Decryption resolves through the binding: the credential is never
    // decrypted with B's field list, and B's code never gets it.
    await expect(
      sourceConnectionManager.getSourceConnection(conn._id.toString()),
    ).rejects.toThrow(/no longer exists/i);
  });
});
