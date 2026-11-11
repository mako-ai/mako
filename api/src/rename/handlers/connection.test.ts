/**
 * The connection rename handler, through the registry: source AND database
 * connections, real Mongo (mongodb-memory-server).
 *
 * PERMISSIONS: the people the kinds' own update routes take. A source
 * connection: one of its managers or the workspace owner, never a viewer
 * (as `update_connection`). A database connection: owner, admin or member.
 * A credential with no person behind it: neither.
 *
 * SECRETS: only `name` is written; the stored document is compared raw.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DatabaseConnection,
  SourceConnection,
  WorkspaceMember,
} from "../../database/workspace-schema";
import { encryptString } from "../../services/crypto.service";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
let WS: string;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??=
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    SourceConnection.deleteMany({}),
    DatabaseConnection.deleteMany({}),
    WorkspaceMember.deleteMany({}),
  ]);
  WS = new Types.ObjectId().toString();
  for (const [userId, role] of [
    ["owner1", "owner"],
    ["admin1", "admin"],
    ["manager1", "member"],
    ["member2", "member"],
    ["viewer1", "viewer"],
  ] as const) {
    await WorkspaceMember.create({
      workspaceId: new Types.ObjectId(WS),
      userId,
      role,
      joinedAt: new Date(),
    });
  }
});

async function seedSource(name: string, workspaceId = WS): Promise<string> {
  const doc = await SourceConnection.create({
    workspaceId: new Types.ObjectId(workspaceId),
    name,
    type: "custom_api",
    config: {
      base_url: "https://api.example.com/v3",
      token: encryptString("tok_do_not_touch"),
    },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: "manager1",
    managers: ["manager1"],
  });
  return doc._id.toString();
}

async function seedDatabase(name: string): Promise<string> {
  const doc = await DatabaseConnection.create({
    workspaceId: new Types.ObjectId(WS),
    name,
    type: "postgresql",
    connection: { host: "db.local", database: "app" },
    createdBy: "manager1",
  });
  return doc._id.toString();
}

/** A caller as the REST route and the tool build it: live role included. */
const as = (userId: string, role?: string) => ({
  workspaceId: WS,
  userId,
  role,
});
const rename = (
  ctx: { workspaceId: string; userId?: string; role?: string },
  ref: string,
  title: string,
) => renameObject(ctx, "connection", { ref, title });

describe("resolving a connection", () => {
  it("finds a source connection at /cx/<id>, a database connection with no url, and either by a name only it has", async () => {
    const source = await seedSource("Stripe prod");
    const database = await seedDatabase("Warehouse");
    const ctx = as("member2");
    expect(await resolveObjectRef(ctx, "connection", source)).toEqual({
      kind: "connection",
      id: source,
      via: "current",
      current: { title: "Stripe prod", url: `/cx/${source}` },
    });
    expect(await resolveObjectRef(ctx, "connection", database)).toEqual({
      kind: "connection",
      id: database,
      via: "current",
      current: { title: "Warehouse" },
    });
    expect((await resolveObjectRef(ctx, "connection", "Warehouse"))?.id).toBe(
      database,
    );
    await seedSource("Warehouse"); // now two things answer to that name
    expect(await resolveObjectRef(ctx, "connection", "Warehouse")).toBeNull();
  });

  it("never reaches another workspace's connection, and reads a 12-character name as a name", async () => {
    const other = new Types.ObjectId().toString();
    const foreign = await seedSource("Close", other);
    const ctx = as("member2");
    expect(await resolveObjectRef(ctx, "connection", foreign)).toBeNull();
    expect(await resolveObjectRef(ctx, "connection", "Close")).toBeNull();
    const twelve = await seedSource("stripe_prod1");
    expect(
      (await resolveObjectRef(ctx, "connection", "stripe_prod1"))?.id,
    ).toBe(twelve);
  });
});

describe("renaming a source connection", () => {
  it("changes the name only: same id, nothing stored beside it touched, and a warning about references by name", async () => {
    const id = await seedSource("ch_close");
    const stored = async () => {
      const row = await SourceConnection.collection.findOne({
        _id: new Types.ObjectId(id),
      });
      return { ...row, name: undefined, updatedAt: undefined };
    };
    const before = await stored();
    const result = await rename(as("manager1", "member"), id, "Close CH");
    expect(result).toMatchObject({
      kind: "connection",
      id,
      before: { title: "ch_close", url: `/cx/${id}` },
      after: { title: "Close CH", url: `/cx/${id}` },
      aliasesAdded: [],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('connection("ch_close")');
    expect(result.warnings[0]).toContain(id);
    expect((await SourceConnection.findById(id).lean())?.name).toBe("Close CH");
    expect(await stored()).toEqual(before);
    // The old name is not an alias: it resolves to nothing from now on.
    expect(
      await resolveObjectRef(as("manager1"), "connection", "ch_close"),
    ).toBeNull();
  });

  it("takes one of its managers or the workspace owner, as update_connection does", async () => {
    const id = await seedSource("inbox");
    for (const [userId, role] of [
      ["member2", "member"],
      ["admin1", "admin"],
    ]) {
      await expect(rename(as(userId, role), id, "x")).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(/managers/),
      });
    }
    await expect(
      rename(as("viewer1", "viewer"), id, "x"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Viewers/),
    });
    await expect(rename({ workspaceId: WS }, id, "x")).rejects.toMatchObject({
      status: 403,
    });
    expect((await SourceConnection.findById(id).lean())?.name).toBe("inbox");

    await rename(as("owner1", "owner"), id, "inbox 2");
    // No role handed in: it is looked up live.
    await rename(as("manager1"), id, "inbox 3");
    await expect(rename(as("member2"), id, "x")).rejects.toMatchObject({
      status: 403,
    });
    expect((await SourceConnection.findById(id).lean())?.name).toBe("inbox 3");
  });

  it("refuses a name another source connection has, and a name two connections answer to", async () => {
    const id = await seedSource("stripe");
    await seedSource("close");
    await expect(
      rename(as("manager1", "member"), id, "close"),
    ).rejects.toMatchObject({ status: 409 });
    await seedDatabase("close");
    await expect(
      rename(as("manager1", "member"), "close", "anything"),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Pass the id/),
    });
    expect((await SourceConnection.findById(id).lean())?.name).toBe("stripe");
  });
});

describe("renaming a database connection", () => {
  it("takes an owner, admin or member; never a viewer or a credential with no person", async () => {
    const id = await seedDatabase("BQ");
    const result = await rename(as("member2", "member"), id, "BigQuery");
    expect(result).toMatchObject({
      id,
      before: { title: "BQ" },
      after: { title: "BigQuery" },
      warnings: [],
    });
    expect(result.after.url).toBeUndefined();
    await rename(as("admin1"), "BigQuery", "Warehouse");
    for (const ctx of [as("viewer1", "viewer"), { workspaceId: WS }]) {
      await expect(rename(ctx, id, "PG")).rejects.toMatchObject({
        status: 403,
      });
    }
    expect((await DatabaseConnection.findById(id).lean())?.name).toBe(
      "Warehouse",
    );
  });
});

describe("what a connection rename refuses or leaves alone", () => {
  it("a slug, a name the rules refuse, and a connection that is not there", async () => {
    const id = await seedDatabase("Postgres");
    const member = as("member2", "member");
    await expect(
      renameObject(member, "connection", { ref: id, slug: "pg" }),
    ).rejects.toMatchObject({ status: 400 });
    for (const title of ["a\nb", "\u{202E}gnp.exe", "x".repeat(101), "  "]) {
      await expect(rename(member, id, title)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(
      rename(member, new Types.ObjectId().toString(), "x"),
    ).rejects.toMatchObject({ status: 404 });
    expect((await DatabaseConnection.findById(id).lean())?.name).toBe(
      "Postgres",
    );
  });

  it("stores the name normalised, and answers its current name as nothing to change", async () => {
    const id = await seedDatabase("Postgres");
    const member = as("member2", "member");
    await rename(member, id, "  Cafe\u{301} DB ");
    expect((await DatabaseConnection.findById(id).lean())?.name).toBe(
      "Caf\u{E9} DB",
    );
    const again = await rename(as("viewer1", "viewer"), id, "Caf\u{E9} DB");
    expect(again.warnings[0]).toMatch(/Nothing to change/);
    expect(again.before).toEqual(again.after);
  });
});
