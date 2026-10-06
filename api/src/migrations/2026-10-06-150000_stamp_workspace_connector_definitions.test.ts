/**
 * The stamping migration binds a `ws:` connection to the definition its
 * type names by CURRENT slug — never through an alias — and leaves the
 * rest unstamped (they then fail closed). Idempotent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { up } from "./2026-10-06-150000_stamp_workspace_connector_definitions";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  for (const name of ["connectors", "connectordefinitions"]) {
    await mongoose.connection.collection(name).deleteMany({});
  }
});

function db() {
  const d = mongoose.connection.db;
  if (!d) throw new Error("mongoose is not connected");
  return d;
}

describe("stamp workspace connector definitions", () => {
  it("binds by current slug only; alias-only and foreign-workspace types stay unstamped; stamped rows are kept", async () => {
    const ws = new Types.ObjectId();
    const otherWs = new Types.ObjectId();
    const defs = db().collection("connectordefinitions");
    const conns = db().collection("connectors");
    const row = (
      slug: string,
      workspaceId: Types.ObjectId,
      aliases: string[] = [],
    ) => ({
      workspaceId,
      slug,
      aliases,
      retiredAliases: [],
      sha: "a",
      sourceSha: "s",
      status: "indexed",
      entities: [],
    });
    const { insertedId: acme2 } = await defs.insertOne(
      row("acme2", ws, ["acme"]),
    );
    const { insertedId: foreign } = await defs.insertOne(row("acme", otherWs));
    const base = {
      workspaceId: ws,
      config: {},
      settings: {},
      createdBy: "u1",
      isActive: true,
    };
    const { insertedId: byCurrent } = await conns.insertOne({
      ...base,
      name: "cur",
      type: "ws:acme2",
    });
    const { insertedId: byAlias } = await conns.insertOne({
      ...base,
      name: "alias",
      type: "ws:acme",
    });
    const { insertedId: builtin } = await conns.insertOne({
      ...base,
      name: "stripe",
      type: "stripe",
    });
    const { insertedId: stamped } = await conns.insertOne({
      ...base,
      name: "stamped",
      type: "ws:acme2",
      connectorDefinitionId: foreign,
    });

    await up(db());
    await up(db()); // idempotent

    const get = async (id: unknown) =>
      conns.findOne({ _id: id as Types.ObjectId });
    expect(String((await get(byCurrent))?.connectorDefinitionId)).toBe(
      String(acme2),
    );
    expect((await get(byAlias))?.connectorDefinitionId).toBeUndefined();
    expect((await get(builtin))?.connectorDefinitionId).toBeUndefined();
    expect(String((await get(stamped))?.connectorDefinitionId)).toBe(
      String(foreign),
    );
  });
});
