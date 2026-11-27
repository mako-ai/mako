/**
 * The Mongo drop script's safety rules (drop-migrated-mongo-collections.ts).
 *
 * Claims: the allowlist and the denylist never overlap; a denied name is
 * never a candidate; nothing drops without --apply AND --confirm-pg-only;
 * a pg_only collection drops only when its domain is pg_only everywhere;
 * a write in the last 24h blocks a drop unless --force; and against a real
 * (in-memory) Mongo the run drops exactly the collections that pass.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Double, MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  DEAD_COLLECTIONS,
  PG_ONLY_COLLECTIONS,
  assertListsAreSafe,
  cli,
  decideDrop,
  isDenied,
  archiveCollection,
  hasWriteSince,
  RECENT_WRITE_WINDOW_MS,
  parseDropArgs,
  planCandidates,
  runDrop,
  summarizeDomainState,
  type DomainStateReader,
} from "./drop-migrated-mongo-collections";

async function main() {
  // ── The lists ──
  assert.equal(Object.keys(PG_ONLY_COLLECTIONS).length, 50);
  assert.equal(DEAD_COLLECTIONS.length, 14);
  assert.doesNotThrow(assertListsAreSafe);
  for (const name of [
    "flows",
    "flow_executions",
    "flow_execution_locks",
    "flow_data_diffs",
    "webhookevents",
    "cdc_change_events",
    "cdc_state",
    "backfill_tmp_abc",
    "poll_tmp_abc",
    "connector_box",
    "connector_boxes",
    "dbt_runs",
    "notification_rules",
    "workflow_recorded_writes",
    "modelcatalogsnapshots",
    "apps_box_policy",
    "realtime_presence",
    "migrations",
    "worker_locks",
    "v1_artifact_purge_backlog",
    "system.views",
  ]) {
    assert.ok(isDenied(name), `${name} must be denied`);
  }
  for (const name of [
    ...Object.keys(PG_ONLY_COLLECTIONS),
    ...DEAD_COLLECTIONS,
  ]) {
    assert.ok(!isDenied(name), `${name} is allowlisted and must not be denied`);
  }

  // ── Arguments ──
  assert.deepEqual(parseDropArgs([]), {
    apply: false,
    includeDead: false,
    force: false,
  });
  assert.equal(parseDropArgs(["--apply", "--confirm-pg-only"]).apply, true);
  assert.throws(() => parseDropArgs(["--apply"]), /go together/);
  assert.throws(() => parseDropArgs(["--confirm-pg-only"]), /go together/);
  assert.throws(() => parseDropArgs(["--drop"]), /Unknown argument/);
  assert.throws(() => parseDropArgs(["--only"]), /--only needs/);
  assert.deepEqual(parseDropArgs(["--only", "users, chats"]).only, [
    "users",
    "chats",
  ]);

  // ── Planning ──
  const existing = ["users", "chats", "flows", "dashboards", "cdc_x", "misc"];
  const plain = planCandidates(existing, { includeDead: false });
  assert.deepEqual(
    plain.candidates.map(c => c.name),
    ["users", "chats"],
  );
  const withDead = planCandidates(existing, { includeDead: true });
  assert.deepEqual(
    withDead.candidates.map(c => c.name),
    ["users", "chats", "dashboards"],
  );
  const asked = planCandidates(existing, {
    includeDead: false,
    only: ["flows", "misc", "dashboards", "users", "sessions"],
  });
  assert.deepEqual(
    asked.candidates.map(c => c.name),
    ["users"],
  );
  assert.deepEqual(
    Object.fromEntries(asked.skipped.map(s => [s.name, s.reason])),
    {
      flows: "denylisted",
      misc: "not allowlisted",
      dashboards: "dead: needs --include-dead",
      sessions: "absent",
    },
  );

  assert.deepEqual(
    planCandidates(["constructor", "users"], {
      only: ["constructor", "users", "users"],
      includeDead: false,
    }).candidates,
    [{ name: "users", domain: "auth", group: "pg_only" }],
  );

  // ── The gate ──
  const users = { name: "users", group: "pg_only", domain: "auth" } as const;
  const dead = { name: "dashboards", group: "dead" } as const;
  const ok = (r: { drop: boolean }) => r.drop;
  assert.ok(
    ok(
      decideDrop(
        users,
        { recentWrite: false, domainPgOnly: true },
        { force: false },
      ),
    ),
  );
  assert.ok(
    !ok(
      decideDrop(
        users,
        { recentWrite: false, domainPgOnly: false },
        { force: true },
      ),
    ),
  );
  assert.ok(
    !ok(
      decideDrop(
        users,
        { recentWrite: false, domainPgOnly: "unknown" },
        { force: true },
      ),
    ),
  );
  assert.ok(
    !ok(
      decideDrop(
        users,
        { recentWrite: true, domainPgOnly: true },
        { force: false },
      ),
    ),
  );
  assert.ok(
    ok(
      decideDrop(
        users,
        { recentWrite: true, domainPgOnly: true },
        { force: true },
      ),
    ),
  );
  assert.ok(
    !ok(
      decideDrop(
        users,
        { recentWrite: "unknown", domainPgOnly: true },
        { force: false },
      ),
    ),
  );
  assert.ok(!ok(decideDrop(dead, { recentWrite: "unknown" }, { force: true })));
  assert.ok(ok(decideDrop(dead, { recentWrite: false }, { force: false })));
  assert.ok(!ok(decideDrop(dead, { recentWrite: true }, { force: false })));
  assert.ok(
    !ok(
      decideDrop(
        { name: "flows", group: "dead" },
        { recentWrite: false },
        { force: true },
      ),
    ),
    "a denied name is refused even if it reaches the gate",
  );

  // ── Domain state ──
  const state = summarizeDomainState(
    ["auth", "chat", "mcp", "connections"],
    [
      { domain: "auth", scopeKey: "global", mode: "pg_only" },
      { domain: "chat", scopeKey: "global", mode: "pg_only" },
      {
        domain: "chat",
        scopeKey: "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        mode: "dual_write_pg_read",
      },
      { domain: "mcp", scopeKey: "global", mode: "dual_write_mongo_read" },
    ],
  );
  assert.equal(state.get("auth"), true);
  assert.equal(state.get("chat"), false, "a workspace override blocks it");
  assert.equal(state.get("mcp"), false);
  assert.equal(state.get("connections"), false, "no row = mongo_only");

  // ── Usage: exit 2, never connects ──
  const usage: string[] = [];
  const code = await cli(
    ["--apply"],
    { out: l => usage.push(l), err: l => usage.push(l) },
    { DATABASE_URL: "mongodb://127.0.0.1:1/never-connected" },
  );
  assert.equal(code, 2);
  assert.ok(usage.join("\n").includes("Usage:"));

  // ── End to end against in-memory Mongo ──
  const mongod = await MongoMemoryServer.create({
    instance: { args: ["--setParameter", "enableTestCommands=1"] },
  });
  const client = new MongoClient(mongod.getUri());
  await client.connect();
  try {
    const db = client.db("drop_test");
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const cutoff = new Date(now.getTime() - RECENT_WRITE_WINDOW_MS);
    const old = new Date(cutoff.getTime() - RECENT_WRITE_WINDOW_MS);
    const oldId = () => ObjectId.createFromTime(old.getTime() / 1000);
    await db.collection("users").insertOne({ _id: oldId(), updatedAt: old });
    await db
      .collection("chats")
      .insertOne({ _id: oldId(), updatedAt: now, value: new Double(2) });
    await db.collection("mcp_servers").insertOne({ _id: oldId() });
    await db.collection("dashboards").insertOne({ _id: oldId() });
    await db.collection("flows").insertOne({ _id: oldId() });
    await db.collection("cdc_change_events").insertOne({ _id: oldId() });
    await db.collection("realtime_presence").insertOne({ _id: oldId() });

    for (const [name, activity] of [
      ["app_usage_daily", { lastAt: now }],
      ["es_close_leads", { date_updated: now.toISOString() }],
      ["es_stripe_invoices", { created: now.getTime() / 1000 }],
      ["skill_usage_daily", { lastAt: now.getTime() }],
    ] as const) {
      await db.collection(name).insertOne({ _id: oldId(), ...activity });
      assert.equal(await hasWriteSince(db, name, cutoff), true, name);
      await db.collection(name).drop();
    }

    // A malformed import cannot hide another document's valid timestamp.
    const leads = db.collection("es_close_leads");
    await leads.insertOne({
      _id: ObjectId.createFromTime(1),
      date_created: "9999-not-a-date",
      updatedAt: true,
    });
    assert.equal(await hasWriteSince(db, leads.collectionName, cutoff), false);
    await leads.updateOne(
      {},
      {
        $set: {
          updatedAt: { invalid: true },
          date_updated: "2025-01-01T23:55:00-02:00",
        },
      },
    );
    assert.equal(
      await hasWriteSince(
        db,
        leads.collectionName,
        new Date("2025-01-02T01:54:00Z"),
      ),
      true,
    );
    assert.equal(
      await hasWriteSince(
        db,
        leads.collectionName,
        new Date("2025-01-02T01:56:00Z"),
      ),
      false,
    );
    await leads.drop();

    const reader: DomainStateReader = async domains =>
      new Map(domains.map(d => [d, d !== "mcp"]));
    const names = async () =>
      (await db.listCollections({}, { nameOnly: true }).toArray())
        .map(c => c.name)
        .sort();
    const before = await names();
    const quiet = { out: () => {}, err: () => {} };

    // Dry run: decisions, nothing dropped.
    const out: string[] = [];
    const dry = await runDrop(
      db,
      parseDropArgs(["--include-dead"]),
      { out: l => out.push(l), err: l => out.push(l) },
      reader,
      now,
    );
    assert.deepEqual(await names(), before, "dry run drops nothing");
    const decisions = Object.fromEntries(
      dry.rows.map(r => [r.name, r.decision]),
    );
    assert.deepEqual(decisions, {
      users: "would drop",
      chats: "written in last 24h (--force)",
      mcp_servers: "mcp: not pg_only",
      dashboards: "would drop",
    });
    assert.ok(out.join("\n").includes("DRY RUN"));
    assert.ok(!out.join("\n").includes("mongodb://"), "never prints the URL");

    // PG unreadable: every pg_only drop is refused, dead ones still pass.
    const noPg = await runDrop(
      db,
      parseDropArgs(["--include-dead"]),
      quiet,
      async () => {
        throw new Error("no postgres");
      },
      now,
    );
    assert.deepEqual(
      noPg.rows.filter(r => r.decision === "would drop").map(r => r.name),
      ["dashboards"],
    );

    // Apply without --include-dead: only users goes.
    await runDrop(
      db,
      parseDropArgs(["--apply", "--confirm-pg-only"]),
      quiet,
      reader,
      now,
    );
    assert.deepEqual(
      await names(),
      before.filter(n => n !== "users"),
    );

    // Force permits a preexisting recent write. A later edit after the
    // cursor has passed must preserve the collection, including on retries.
    const raceDir = await mkdtemp(
      path.join(os.tmpdir(), "mongo-archive-race-"),
    );
    try {
      const options = parseDropArgs([
        "--apply",
        "--confirm-pg-only",
        "--force",
        "--only",
        "chats",
        "--archive-dir",
        raceDir,
      ]);
      const raced = await runDrop(
        db,
        options,
        quiet,
        reader,
        now,
        async (target, name, dir) => {
          const file = await archiveCollection(target, name, dir);
          await target
            .collection(name)
            .updateOne({}, { $set: { updatedAt: new Date(), late: true } });
          return file;
        },
      );
      assert.equal(raced.rows[0].decision, "written during archive");
      assert.equal(
        await db.collection("chats").countDocuments({ late: true }),
        1,
      );
      const partial = gunzipSync(
        await readFile(path.join(raceDir, "drop_test.chats.ejson.gz")),
      ).toString();
      assert.equal(JSON.parse(partial).late, undefined);
      await db.collection("chats").updateOne({}, { $set: { updatedAt: now } });
    } finally {
      await rm(raceDir, { recursive: true, force: true });
    }

    const failureDir = await mkdtemp(
      path.join(os.tmpdir(), "mongo-archive-check-"),
    );
    try {
      const options = parseDropArgs([
        "--apply",
        "--confirm-pg-only",
        "--force",
        "--only",
        "chats",
        "--archive-dir",
        failureDir,
      ]);
      const failed = await runDrop(
        db,
        options,
        quiet,
        reader,
        now,
        async (target, name, dir) => {
          const file = await archiveCollection(target, name, dir);
          await target.admin().command({
            configureFailPoint: "failCommand",
            mode: { times: 1 },
            data: { failCommands: ["find"], errorCode: 13 },
          });
          return file;
        },
      );
      assert.equal(failed.rows[0].decision, "post-archive write check failed");
      assert.equal(await db.collection("chats").countDocuments(), 1);
    } finally {
      await rm(failureDir, { recursive: true, force: true });
    }

    // Apply with --force + --include-dead: chats and dashboards go too,
    // each archived first.
    const archiveDir = await mkdtemp(path.join(os.tmpdir(), "mongo-drop-"));
    try {
      await runDrop(
        db,
        parseDropArgs([
          "--apply",
          "--confirm-pg-only",
          "--force",
          "--include-dead",
          "--archive-dir",
          archiveDir,
        ]),
        quiet,
        reader,
        now,
      );
      assert.deepEqual((await readdir(archiveDir)).sort(), [
        "drop_test.chats.ejson.gz",
        "drop_test.dashboards.ejson.gz",
      ]);
      const chatsDump = gunzipSync(
        await readFile(path.join(archiveDir, "drop_test.chats.ejson.gz")),
      ).toString();
      assert.equal(chatsDump.trim().split("\n").length, 1);
      assert.ok(chatsDump.includes("$oid"), "archive is canonical EJSON");
      assert.deepEqual(JSON.parse(chatsDump).value, { $numberDouble: "2.0" });

      await db.collection("chats").insertOne({ _id: oldId(), updatedAt: old });
      const retry = await runDrop(
        db,
        parseDropArgs([
          "--apply",
          "--confirm-pg-only",
          "--only",
          "chats",
          "--archive-dir",
          archiveDir,
        ]),
        quiet,
        reader,
        now,
      );
      assert.match(retry.rows[0].decision, /archive failed/);
      assert.equal(await db.collection("chats").countDocuments(), 1);
      assert.equal(
        gunzipSync(
          await readFile(path.join(archiveDir, "drop_test.chats.ejson.gz")),
        ).toString(),
        chatsDump,
      );
    } finally {
      await rm(archiveDir, { recursive: true, force: true });
    }
    assert.deepEqual(await names(), [
      "cdc_change_events",
      "chats",
      "flows",
      "mcp_servers",
      "realtime_presence",
    ]);
  } finally {
    await client.close();
    await mongod.stop();
  }
  process.stdout.write("drop-migrated-mongo-collections: ok\n");
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
