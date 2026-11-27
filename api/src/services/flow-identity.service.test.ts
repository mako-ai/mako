/**
 * Flow identity: name + slug (RFC #904 block 1).
 *
 * Covers the pure slug rules, per-workspace slug reservation, the
 * display-name fallback, and the backfill migration end-to-end against
 * in-memory Mongo — the migration is the risky part (it mutates every
 * existing flow), so it is exercised with real documents including the
 * duplicate source→destination pairs that prod actually has.
 *
 * Modern flows and the raw pre-backfill documents use separate databases
 * on one in-memory Mongo server. Modern connection names live in PGlite.
 *
 * Run: npx tsx src/services/flow-identity.service.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import {
  ensureTestDatabaseConnection,
  ensureTestSourceConnection,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../test-support/pg-test";
import { reserveSlug, slugifyName } from "../utils/slugify";

async function main(): Promise<void> {
  // ── pure slug rules ──
  assert.equal(slugifyName("Stripe → Warehouse"), "stripe-warehouse");
  assert.equal(
    slugifyName("es_close → RevOps.es_close"),
    "es-close-revops-es-close",
  );
  // Accents fold rather than vanish.
  assert.equal(slugifyName("Café → Zürich"), "cafe-zurich");
  // Leading/trailing punctuation never leaks into the filename.
  assert.equal(slugifyName("  --Hello--  "), "hello");
  // A name with nothing slug-able falls back rather than producing "".
  assert.equal(slugifyName("→ ✨ →", { fallback: "flow" }), "flow");
  assert.equal(slugifyName("", { fallback: "flow" }), "flow");
  // Truncation must not leave a trailing dash (slicing can land mid-word).
  const long = slugifyName("a".repeat(60) + " tail word", { maxLength: 64 });
  assert.ok(long.length <= 64, "respects maxLength");
  assert.ok(!long.endsWith("-"), `no trailing dash: ${long}`);

  // ── reserveSlug: first free candidate ──
  const used = new Set(["taken", "taken-2"]);
  assert.equal(await reserveSlug("taken", async c => used.has(c)), "taken-3");
  assert.equal(await reserveSlug("free", async () => false), "free");
  await assert.rejects(
    () => reserveSlug("x", async () => true, { limit: 3 }),
    /Could not find a free slug/,
  );

  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const pgh = await setupPgTestDb();
  try {
    const { Flow } = await import("../database/workspace-schema");
    await Flow.init();
    const { reserveFlowSlug, flowDisplayName, deriveFlowDisplayName } =
      await import("./flow-identity.service");

    const wsA = new Types.ObjectId();
    const wsB = new Types.ObjectId();
    const destId = new Types.ObjectId();
    const sourceId = new Types.ObjectId();
    await ensureTestWorkspace(pgh.db, { id: wsA.toString() });
    await ensureTestWorkspace(pgh.db, { id: wsB.toString() });
    await ensureTestDatabaseConnection(pgh.db, {
      workspaceId: wsA.toString(),
      id: destId.toString(),
      name: "Warehouse",
    });
    await ensureTestSourceConnection(pgh.db, {
      workspaceId: wsA.toString(),
      id: sourceId.toString(),
      name: "Stripe",
    });

    const makeFlow = (
      workspaceId: Types.ObjectId,
      slug: string,
      name?: string,
    ) =>
      Flow.create({
        workspaceId,
        slug,
        name,
        type: "scheduled",
        sourceType: "connector",
        dataSourceId: sourceId,
        destinationDatabaseId: destId,
        createdBy: "u1",
        schedule: { enabled: false },
      });

    // ── slug reservation is per workspace ──
    await makeFlow(wsA, "stripe-warehouse", "Stripe → Warehouse");
    assert.equal(
      await reserveFlowSlug(wsA, "Stripe → Warehouse"),
      "stripe-warehouse-2",
      "a taken slug steps aside within the workspace",
    );
    assert.equal(
      await reserveFlowSlug(wsB, "Stripe → Warehouse"),
      "stripe-warehouse",
      "another workspace is free to use the same slug",
    );
    await assert.rejects(() => makeFlow(wsA, "stripe-warehouse"), {
      code: 11000,
      keyPattern: { workspaceId: 1, slug: 1 },
    });
    await makeFlow(wsB, "stripe-warehouse");

    // ── display name prefers the stored value ──
    const named = await makeFlow(
      wsA,
      "nightly-revenue-sync",
      "Nightly revenue sync",
    );
    assert.equal(await flowDisplayName(named), "Nightly revenue sync");
    const unnamed = await makeFlow(wsA, "unnamed-flow");
    const derived = await flowDisplayName(unnamed);
    assert.match(derived, /→/, "falls back to the source → destination label");
    assert.equal(derived, "Stripe → Warehouse", "names come from Postgres");
    assert.equal(derived, await deriveFlowDisplayName(unnamed));
    // A blank name is not a name.
    const blank = await makeFlow(wsA, "blank-name-flow", "   ");
    assert.match(await flowDisplayName(blank), /→/);

    // ── the backfill migration ──
    // The modern compound index treats missing slugs in a workspace as
    // duplicates. Seed the pre-backfill data in its own raw database.
    const historicalDb = mongoose.connection.getClient().db("historical_flows");
    const connId = new Types.ObjectId();
    const connectorId = new Types.ObjectId();
    await historicalDb
      .collection("databaseconnections")
      .insertOne({ _id: connId, name: "RevOps" });
    await historicalDb
      .collection("connectors")
      .insertOne({ _id: connectorId, name: "ch_close" });

    // Two flows sharing one source→destination pair: prod has exactly this,
    // and it is what forces the -2 suffix.
    const raw = historicalDb.collection("flows");
    const ids = [
      new Types.ObjectId(),
      new Types.ObjectId(),
      new Types.ObjectId(),
    ];
    await raw.insertMany([
      {
        _id: ids[0],
        workspaceId: wsA,
        type: "scheduled",
        sourceType: "connector",
        dataSourceId: connectorId,
        destinationDatabaseId: connId,
        tableDestination: { connectionId: connId, tableName: "ch_close" },
        createdBy: "u1",
      },
      {
        _id: ids[1],
        workspaceId: wsA,
        type: "scheduled",
        sourceType: "connector",
        dataSourceId: connectorId,
        destinationDatabaseId: connId,
        tableDestination: { connectionId: connId, tableName: "ch_close" },
        createdBy: "u1",
      },
      // Same derived name, DIFFERENT workspace — must not be suffixed.
      {
        _id: ids[2],
        workspaceId: wsB,
        type: "scheduled",
        sourceType: "connector",
        dataSourceId: connectorId,
        destinationDatabaseId: connId,
        tableDestination: { connectionId: connId, tableName: "ch_close" },
        createdBy: "u1",
      },
    ]);

    const migration =
      await import("../migrations/2026-09-01-190000_flow_names_and_slugs");
    await migration.up(historicalDb);

    const after = await raw.find({}).sort({ _id: 1 }).toArray();
    const byId = (id: Types.ObjectId) =>
      after.find(f => f._id.toString() === id.toString()) as {
        name?: string;
        slug?: string;
      };

    assert.equal(byId(ids[0]).name, "ch_close → RevOps.ch_close");
    assert.equal(byId(ids[0]).slug, "ch-close-revops-ch-close");
    assert.equal(
      byId(ids[1]).slug,
      "ch-close-revops-ch-close-2",
      "a duplicate derived name gets a suffixed slug",
    );
    assert.equal(
      byId(ids[2]).slug,
      "ch-close-revops-ch-close",
      "the other workspace keeps the unsuffixed slug",
    );
    for (const f of after) {
      assert.match(
        f.slug as string,
        /^[a-z0-9][a-z0-9-]*$/,
        "every slug satisfies the schema's pattern",
      );
    }

    // ── idempotent: a second run changes nothing ──
    const before = JSON.stringify(
      after.map(f => [f._id.toString(), f.name, f.slug]),
    );
    await migration.up(historicalDb);
    const again = await raw.find({}).sort({ _id: 1 }).toArray();
    assert.equal(
      JSON.stringify(again.map(f => [f._id.toString(), f.name, f.slug])),
      before,
      "re-running the migration is a no-op",
    );

    // ── an existing name is preserved, only the slug is minted ──
    await raw.insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsA,
      type: "scheduled",
      sourceType: "connector",
      dataSourceId: connectorId,
      destinationDatabaseId: connId,
      name: "Hand-written name",
      createdBy: "u1",
    });
    await migration.up(historicalDb);
    const hand = (await raw.findOne({ name: "Hand-written name" })) as {
      slug?: string;
    };
    assert.equal(hand.slug, "hand-written-name");

    console.log("flow-identity tests passed");
  } finally {
    await pgh.close();
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
