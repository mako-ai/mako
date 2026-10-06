/**
 * The connection rename handler: source AND database connections, Mongo
 * only (mongodb-memory-server). Secrets are encrypted at rest by the
 * schemas, so an encryption key is set exactly as the connection route
 * tests do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const MEMBER = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await SourceConnection.deleteMany({});
  await DatabaseConnection.deleteMany({});
});

async function seedSource(name: string): Promise<string> {
  const doc = await SourceConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name,
    type: "stripe",
    config: { api_key: "sk_test_123" },
    createdBy: MEMBER,
    settings: {
      sync_batch_size: 100,
      rate_limit_delay_ms: 0,
      max_retries: 1,
    },
    isActive: true,
  });
  return doc._id.toString();
}

async function seedDatabase(name: string): Promise<string> {
  const doc = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name,
    type: "postgresql",
    connection: { host: "db.local", database: "app" },
    createdBy: MEMBER,
  });
  return doc._id.toString();
}

const member = { workspaceId: WS, userId: MEMBER, role: "member" };
const viewer = { workspaceId: WS, userId: VIEWER, role: "viewer" };
const apiKey = { workspaceId: WS };

describe("connection rename", () => {
  it("resolves a source connection to /cx/<id>, a database connection with no url, and a unique name", async () => {
    const source = await seedSource("Stripe prod");
    const database = await seedDatabase("Warehouse");
    expect(await resolveObjectRef(member, "connection", source)).toMatchObject({
      kind: "connection",
      id: source,
      via: "current",
      current: { title: "Stripe prod", url: `/cx/${source}` },
    });
    const db = await resolveObjectRef(member, "connection", database);
    expect(db).toMatchObject({ id: database, current: { title: "Warehouse" } });
    expect(db?.current.url).toBeUndefined();
    expect(
      (await resolveObjectRef(member, "connection", "Warehouse"))?.id,
    ).toBe(database);
    await seedSource("Warehouse"); // now two things answer to that name
    expect(
      await resolveObjectRef(member, "connection", "Warehouse"),
    ).toBeNull();
  });

  it("renames the display name of either kind; ids and everything that references them stay", async () => {
    const source = await seedSource("Close");
    const database = await seedDatabase("BQ");
    const one = await renameObject(member, "connection", {
      ref: source,
      title: "Close CRM",
    });
    expect(one).toMatchObject({
      id: source,
      before: { title: "Close" },
      after: { title: "Close CRM", url: `/cx/${source}` },
      aliasesAdded: [],
    });
    const two = await renameObject(apiKey, "connection", {
      ref: database,
      title: "BigQuery",
    });
    expect(two.after).toEqual({ title: "BigQuery" });
    expect((await SourceConnection.findById(source))?.name).toBe("Close CRM");
    expect((await DatabaseConnection.findById(database))?.name).toBe(
      "BigQuery",
    );
  });

  it("a viewer may rename a source connection but not a database connection (route parity)", async () => {
    const source = await seedSource("Wise");
    const database = await seedDatabase("Postgres");
    await expect(
      renameObject(viewer, "connection", { ref: source, title: "Wise EU" }),
    ).resolves.toMatchObject({ after: { title: "Wise EU" } });
    await expect(
      renameObject(viewer, "connection", { ref: database, title: "PG" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      renameObject(member, "connection", { ref: database, slug: "pg" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      renameObject(member, "connection", {
        ref: new Types.ObjectId().toString(),
        title: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
