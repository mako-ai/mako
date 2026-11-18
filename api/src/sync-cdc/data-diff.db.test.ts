/**
 * The data-diff check end to end, against an in-memory Mongo and a fake SQL
 * destination that answers the column-list and COUNT queries from rows held
 * in memory: a backfill that NULLs a column is flagged, a table that shrinks
 * is not, a connector-code or destination change opens a check, a reset's
 * baseline survives the drop, and flow_data_diff / flow_status show it.
 *
 * Run: tsx src/sync-cdc/data-diff.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import {
  DatabaseConnection,
  Flow,
  FlowDataDiff,
  SourceConnection,
} from "../database/workspace-schema";
import type { DatabaseDriver } from "../databases/driver";
import { databaseRegistry } from "../databases/registry";
import { createFlowSyncTools } from "../agent-lib/tools/flow-sync-tools";
import {
  buildNonNullCountQuery,
  compareCounts,
  compareFlowDataDiff,
  openFlowDataDiff,
  prepareFlowDataDiff,
} from "./data-diff";

// ---------------------------------------------------------------------------
// A fake destination: schema.table → rows
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const tables = new Map<string, Row[]>();
/** Stored bytes per table, for the sampling path (absent = small). */
const sizes = new Map<string, number>();
/** A table whose COUNT fails. */
const BROKEN: Row[] = [{ id: "x" }];
const queries: string[] = [];

const fakeDriver = {
  getMetadata: () => ({
    type: "fakesql",
    displayName: "Fake SQL",
    consoleLanguage: "sql",
  }),
  getTreeRoot: async () => [],
  getChildren: async () => [],
  formatTableRef: (schema: string | undefined, table: string) =>
    `${schema}.${table}`,
  buildTableStatsQuery: (schema: string, names: string[]) =>
    `STATS ${schema} ${names.join(",")}`,
  tableSampleClause: (percent: number) => `SAMPLE${percent}`,
  executeQuery: async (_db: unknown, sql: string) => {
    queries.push(sql);
    const list = sql.match(
      /information_schema\.columns WHERE table_schema = '([^']+)' AND table_name IN \(([^)]*)\)/,
    );
    if (list) {
      const schema = list[1];
      const names = [...list[2].matchAll(/'([^']+)'/g)].map(m => m[1]);
      const data: Row[] = [];
      for (const name of names) {
        const rows = tables.get(`${schema}.${name}`);
        if (!rows) continue;
        const columns = new Set(rows.flatMap(r => Object.keys(r)));
        for (const column of columns) {
          data.push({ table_name: name, column_name: column });
        }
      }
      return { success: true, data };
    }
    const stats = sql.match(/^STATS (\S+) (.*)$/);
    if (stats) {
      const data = stats[2].split(",").flatMap(name => {
        const rows = tables.get(`${stats[1]}.${name}`);
        return rows
          ? [
              {
                table_name: name,
                row_count: rows.length,
                size_bytes: sizes.get(`${stats[1]}.${name}`) ?? 1000,
              },
            ]
          : [];
      });
      return { success: true, data };
    }
    const count = sql.match(/^SELECT (.*) FROM (\S+)( SAMPLE10)?$/);
    if (count) {
      const all = tables.get(count[2]);
      // A 10% "block" sample: every 10th row.
      const rows =
        all && count[3] && all !== BROKEN
          ? all.filter((_, i) => i % 10 === 0)
          : all;
      if (!rows) return { success: false, error: "Not found: table" };
      if (rows === BROKEN) return { success: false, error: "quota exceeded" };
      const out: Row = { n: rows.length };
      for (const m of count[1].matchAll(/COUNT\(`([^`]+)`\) AS (c_\d+)/g)) {
        out[m[2]] = rows.filter(r => r[m[1]] != null).length;
      }
      return { success: true, data: [out] };
    }
    return { success: false, error: `unexpected query: ${sql}` };
  },
} as unknown as DatabaseDriver;
databaseRegistry.register(fakeDriver);

const people = (n: number, emailEvery = 1): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    email: i % emailEvery === 0 ? `p${i}@x.io` : null,
    created_at: "2026-01-01",
  }));

// ---------------------------------------------------------------------------
// 1. compareCounts, pure
// ---------------------------------------------------------------------------
{
  const before = {
    rows: 1000,
    columns: [
      { name: "email", nonNull: 900 },
      { name: "phone", nonNull: 500 },
      { name: "rare", nonNull: 20 },
    ],
  };
  // email NULLed for 300 rows; phone untouched; rare lost 5 (under 10 rows).
  const flags = compareCounts({
    entity: "contacts",
    table: "contacts",
    before,
    after: {
      rows: 1000,
      columns: [
        { name: "email", nonNull: 600 },
        { name: "phone", nonNull: 500 },
        { name: "rare", nonNull: 15 },
      ],
    },
  });
  assert.deepEqual(
    flags.map(f => [f.column, f.lost, f.lostPct]),
    [["email", 300, 33.33]],
  );

  // The table lost 10% of its rows (a purge): columns that shrank with it
  // are not flagged, the rows are.
  const shrunk = compareCounts({
    entity: "contacts",
    table: "contacts",
    before,
    after: {
      rows: 900,
      columns: [
        { name: "email", nonNull: 810 },
        { name: "phone", nonNull: 450 },
        { name: "rare", nonNull: 18 },
      ],
    },
  });
  assert.deepEqual(
    shrunk.map(f => f.column),
    ["(rows)"],
  );

  // A dropped column counts as zero after.
  const dropped = compareCounts({
    entity: "contacts",
    table: "contacts",
    before,
    after: { rows: 1000, columns: [{ name: "email", nonNull: 900 }] },
  });
  assert.deepEqual(
    dropped.map(f => f.column),
    ["phone", "rare"],
  );

  // Sampled counts compare shares and need a 75% loss: sampling moves a
  // share a lot, a rewrite that empties a column moves it to zero. The
  // table doubled: phone kept its 50% share (fine), email fell from 100%
  // to 50% (noise-sized, fine), fax from 40% to 5% (flagged).
  assert.deepEqual(
    compareCounts({
      entity: "contacts",
      table: "contacts",
      before: {
        rows: 10_000,
        sampled: true,
        columns: [
          { name: "email", nonNull: 10_000 },
          { name: "phone", nonNull: 5_000 },
          { name: "fax", nonNull: 4_000 },
        ],
      },
      after: {
        rows: 20_000,
        sampled: true,
        columns: [
          { name: "email", nonNull: 10_000 },
          { name: "phone", nonNull: 10_000 },
          { name: "fax", nonNull: 1_000 },
        ],
      },
    }).map(f => [f.column, f.expected, f.lostPct]),
    [["fax", 8_000, 87.5]],
  );

  // Growth and a 0.4% dip are fine.
  assert.deepEqual(
    compareCounts({
      entity: "contacts",
      table: "contacts",
      before: { rows: 10_000, columns: [{ name: "email", nonNull: 10_000 }] },
      after: { rows: 12_000, columns: [{ name: "email", nonNull: 9_960 }] },
    }),
    [],
  );

  assert.equal(
    buildNonNullCountQuery({
      tableRef: "`p`.`d`.t",
      columns: ["a", "b c"],
      quote: n => `\`${n}\``,
    }),
    "SELECT COUNT(*) AS n, COUNT(`a`) AS c_0, COUNT(`b c`) AS c_1 FROM `p`.`d`.t",
  );
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const workspaceId = new Types.ObjectId();
    const connectionId = new Types.ObjectId();
    const otherConnectionId = new Types.ObjectId();
    for (const _id of [connectionId, otherConnectionId]) {
      await DatabaseConnection.collection.insertOne({
        _id,
        workspaceId,
        name: "warehouse",
        type: "fakesql",
        connection: {},
      });
    }
    const sourceId = new Types.ObjectId();
    await SourceConnection.collection.insertOne({
      _id: sourceId,
      workspaceId,
      name: "fr_close",
      type: "close",
      config: {},
    });
    const flowId = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id: flowId,
      workspaceId,
      name: "fr_close → warehouse",
      sourceType: "connector",
      dataSourceId: sourceId,
      destinationDatabaseId: connectionId,
      tableDestination: { connectionId, schema: "fr", tableName: "" },
      syncEngine: "cdc",
      backfillState: { status: "running", trigger: "manual" },
    });
    const id = String(flowId);
    const entities = ["contacts", "leads"];
    tables.set("fr.contacts", people(1000));
    tables.set("fr.leads", people(200));

    // 2. A first plain run records the fingerprint and opens nothing.
    assert.deepEqual(
      await prepareFlowDataDiff({ flowId: id, entities, backfill: false }),
      { reasons: [] },
    );
    const stamped = await Flow.findById(flowId).lean();
    // `close` runs its registry twin; with no folder and no registry here
    // the fingerprint says so, and stays the same between runs.
    assert.equal(stamped!.dataDiffFingerprint!.code, "close@unresolved");
    assert.equal(await FlowDataDiff.countDocuments(), 0);
    assert.equal(await compareFlowDataDiff({ flowId: id }), null);

    // 3. A backfill that NULLs half the emails is flagged; leads is not.
    queries.length = 0;
    assert.deepEqual(
      await prepareFlowDataDiff({ flowId: id, entities, backfill: true }),
      { reasons: ["backfill"] },
    );
    // One column list, one size lookup, one COUNT per table.
    assert.equal(queries.length, 4);
    tables.set("fr.contacts", people(1000, 2));
    tables.set("fr.leads", people(210));
    const diff = await compareFlowDataDiff({ flowId: id, executionId: "e1" });
    assert.deepEqual(
      diff!.flagged.map(f => [f.table, f.column, f.before, f.after]),
      [["contacts", "email", 1000, 500]],
    );
    const closed = await FlowDataDiff.findOne({ flowId }).lean();
    assert.equal(closed!.status, "compared");
    assert.equal(closed!.executionId, "e1");
    assert.deepEqual(
      closed!.tables.map(t => [t.entity, t.before?.rows, t.after?.rows]),
      [
        ["contacts", 1000, 1000],
        ["leads", 200, 210],
      ],
    );
    // Nothing open any more: the next run compares nothing.
    assert.equal(await compareFlowDataDiff({ flowId: id }), null);

    // 4. New connector code between two plain runs opens a check.
    await Flow.updateOne(
      { _id: flowId },
      { $set: { "dataDiffFingerprint.code": "close@node:0000000000000000" } },
    );
    assert.deepEqual(
      await prepareFlowDataDiff({ flowId: id, entities, backfill: false }),
      { reasons: ["connector-code-change"] },
    );
    const clean = await compareFlowDataDiff({ flowId: id });
    assert.deepEqual(clean, {
      flagged: [],
      reasons: ["connector-code-change"],
    });

    // 5. A destination change compares the old tables with the new ones.
    tables.set("old.contacts", people(1000));
    tables.set("old.leads", people(210));
    await Flow.updateOne(
      { _id: flowId },
      {
        $set: {
          "dataDiffFingerprint.destination": `${otherConnectionId}|old|`,
        },
      },
    );
    assert.deepEqual(
      await prepareFlowDataDiff({ flowId: id, entities, backfill: true }),
      { reasons: ["backfill", "destination-change"] },
    );
    const moved = await compareFlowDataDiff({ flowId: id });
    assert.deepEqual(
      moved!.flagged.map(f => [f.table, f.column]),
      [["contacts", "email"]],
    );
    const movedRow = await FlowDataDiff.findOne({ flowId })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    assert.equal(movedRow!.from, `${otherConnectionId}|old|`);

    // 6. A reset counts before the drop; the refill that loses created_at on
    //    every row is flagged; the reset's baseline is kept by the backfill.
    tables.set("fr.leads", people(210));
    const flow = (await Flow.findById(flowId))!;
    await openFlowDataDiff({
      flow,
      entities: ["leads"],
      reasons: ["entity-reset"],
    });
    tables.delete("fr.leads");
    await prepareFlowDataDiff({ flowId: id, entities, backfill: true });
    const open = await FlowDataDiff.findOne({ flowId, status: "open" }).lean();
    assert.deepEqual(open!.reasons, ["entity-reset", "backfill"]);
    assert.deepEqual(
      open!.tables.map(t => [t.entity, t.before?.rows]),
      [
        ["leads", 210],
        ["contacts", 1000],
      ],
    );
    tables.set(
      "fr.leads",
      people(210).map(r => ({ ...r, created_at: null })),
    );
    const reset = await compareFlowDataDiff({ flowId: id });
    assert.deepEqual(
      reset!.flagged.map(f => [f.table, f.column, f.lost]),
      [["leads", "created_at", 210]],
    );

    // 7. A table that vanished is one "(rows)" flag, not one per column; a
    //    table whose count fails keeps its error and is never a throw.
    await prepareFlowDataDiff({ flowId: id, entities, backfill: true });
    tables.delete("fr.contacts");
    tables.set("fr.leads", BROKEN);
    const partial = await compareFlowDataDiff({ flowId: id });
    assert.deepEqual(
      partial!.flagged.map(f => [f.table, f.column, f.lost]),
      [["contacts", "(rows)", 1000]],
    );
    const partialRow = await FlowDataDiff.findOne({ flowId })
      .sort({ createdAt: -1, _id: -1 })
      .lean();
    assert.equal(partialRow!.tables[1].error, "quota exceeded");

    // 8. flow_status shows the last check; flow_data_diff lists them all.
    const tools = createFlowSyncTools({ workspaceId: String(workspaceId) });
    const call = (name: string, input: unknown) =>
      (
        tools[name] as unknown as {
          execute: (i: unknown, o: unknown) => Promise<any>;
        }
      ).execute(input, { toolCallId: "t", messages: [] });
    const status = await call("flow_status", { flow: id });
    assert.equal(status.success, true);
    assert.equal(status.dataDiff.status, "compared");
    assert.equal(status.dataDiff.flaggedCount, 1);
    const listed = await call("flow_data_diff", {
      flow: "fr_close",
      limit: 20,
    });
    assert.equal(listed.success, true);
    assert.equal(listed.checks.length, 5);
    assert.deepEqual(listed.checks[4].reasons, ["backfill"]);
    assert.deepEqual(listed.checks[4].flagged[0].column, "email");
    assert.deepEqual(listed.checks[4].tables[1], {
      entity: "leads",
      table: "leads",
      rowsBefore: 200,
      rowsAfter: 210,
    });

    // 9. A table over 1 GB is counted on a 10% sample: exact rows from
    //    metadata, column shares scaled to them. Emptying the emails is
    //    flagged; leads, small, is counted in full.
    tables.set("fr.contacts", people(1000));
    tables.set("fr.leads", people(210));
    sizes.set("fr.contacts", 5e9);
    queries.length = 0;
    await prepareFlowDataDiff({ flowId: id, entities, backfill: true });
    assert.ok(
      queries.includes(
        "SELECT COUNT(*) AS n, COUNT(`id`) AS c_0, COUNT(`email`) AS c_1, COUNT(`created_at`) AS c_2 FROM fr.contacts SAMPLE10",
      ),
    );
    assert.ok(queries.some(q => q.endsWith("FROM fr.leads")));
    const sampledOpen = await FlowDataDiff.findOne({
      flowId,
      status: "open",
    }).lean();
    assert.deepEqual(sampledOpen!.tables[0].before, {
      rows: 1000,
      sampled: true,
      columns: [
        { name: "id", nonNull: 1000 },
        { name: "email", nonNull: 1000 },
        { name: "created_at", nonNull: 1000 },
      ],
    });
    tables.set(
      "fr.contacts",
      people(1000).map((r, i) =>
        Math.floor(i / 10) % 10 < 9 ? { ...r, email: null } : r,
      ),
    );
    const sampledDiff = await compareFlowDataDiff({ flowId: id });
    assert.deepEqual(
      sampledDiff!.flagged.map(f => [f.table, f.column, f.before, f.after]),
      [["contacts", "email", 1000, 100]],
    );

    console.info("data-diff.db.test: ok");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
