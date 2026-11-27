/**
 * The two Mongo migrations on `mcpoauthtokens`, on raw documents.
 *
 * MCP grants now live in Postgres, so `mcp-oauth.service.test.ts` runs on
 * PGlite and no longer drives these migrations. They still ship and still
 * run on any Mongo that has not applied them, so they keep a test of their
 * own: what each one dates or undates, and that a second run changes nothing.
 *
 * Run: node --import tsx src/migrations/mcp-oauth-grant-migrations.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Db } from "mongodb";
import mongoose from "mongoose";
import { McpOAuthToken } from "../database/mcp-oauth-schema";
import { MongoMemoryServer } from "mongodb-memory-server";
import { up as upPersistent } from "./2026-09-06-230000_persistent_mcp_oauth_grants";
import { up as upIdleExpiry } from "./2026-11-14-120000_mcp_oauth_refresh_idle_expiry";

const DAY = 24 * 60 * 60 * 1000;
const ACP = "mako-acp-local";

let mongo: MongoMemoryServer;
let db: Db;

before(async () => {
  mongo = await MongoMemoryServer.create({
    instance: { args: ["--setParameter", "ttlMonitorEnabled=false"] },
  });
  await mongoose.connect(mongo.getUri());
  await McpOAuthToken.init();
  db = mongoose.connection.getClient().db();
});
after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await db.collection("mcpoauthtokens").deleteMany({});
});

function grant(clientId: string, refreshExpiresAt?: Date) {
  return {
    clientId,
    accessTokenHash: clientId,
    refreshTokenHash: clientId,
    ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
  };
}

async function expiryOf(clientId: string): Promise<Date | undefined> {
  const doc = await db.collection("mcpoauthtokens").findOne({ clientId });
  assert.ok(doc, `missing grant ${clientId}`);
  return doc.refreshExpiresAt as Date | undefined;
}

void test("persistent-grants migration undates live grants only", async () => {
  const future = new Date(Date.now() + DAY);
  const past = new Date(Date.now() - DAY);
  await db
    .collection("mcpoauthtokens")
    .insertMany([
      grant("live", future),
      grant("expired", past),
      grant(ACP, future),
    ]);

  await upPersistent(db);
  await upPersistent(db);

  assert.equal(await expiryOf("live"), undefined);
  assert.deepEqual(await expiryOf("expired"), past);
  assert.deepEqual(await expiryOf(ACP), future);
  const indexes = await McpOAuthToken.collection.indexes();
  assert.equal(
    indexes.find(index => index.key.refreshExpiresAt === 1)?.expireAfterSeconds,
    0,
  );
});

void test("idle-expiry migration dates undated grants only", async () => {
  const dated = new Date(Date.now() + 3 * DAY);
  const acpDate = new Date(Date.now() + DAY);
  await db
    .collection("mcpoauthtokens")
    .insertMany([grant("legacy"), grant("dated", dated), grant(ACP, acpDate)]);

  await upIdleExpiry(db);
  const first = await expiryOf("legacy");
  await upIdleExpiry(db);

  assert.ok(first instanceof Date);
  assert.ok(first.getTime() > Date.now() + 29 * DAY);
  assert.deepEqual(await expiryOf("legacy"), first);
  assert.deepEqual(await expiryOf("dated"), dated);
  assert.deepEqual(await expiryOf(ACP), acpDate);
});

void test("idle-expiry migration is a no-op with MCP_REFRESH_TOKEN_IDLE_DAYS=0", async () => {
  const saved = process.env.MCP_REFRESH_TOKEN_IDLE_DAYS;
  process.env.MCP_REFRESH_TOKEN_IDLE_DAYS = "0";
  try {
    await db.collection("mcpoauthtokens").insertOne(grant("legacy"));
    await upIdleExpiry(db);
    assert.equal(await expiryOf("legacy"), undefined);
  } finally {
    if (saved === undefined) delete process.env.MCP_REFRESH_TOKEN_IDLE_DAYS;
    else process.env.MCP_REFRESH_TOKEN_IDLE_DAYS = saved;
  }
});
