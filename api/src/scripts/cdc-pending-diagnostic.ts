/* eslint-disable no-console */
/**
 * READ-ONLY diagnostic for "too many pending events in CDC flows".
 *
 * Why this exists
 * ---------------
 * CDC has two independent "pending" surfaces that pile up for different
 * reasons (see api/src/inngest/functions/webhook-flow.ts):
 *
 *   1. WebhookEvent.status      = "pending"  -> raw webhook not yet INGESTED
 *   2. CdcChangeEvent.materializationStatus = "pending" -> ingested, not yet
 *                                                          MATERIALIZED
 *
 * This script reports the distribution across both surfaces, the top
 * offending flows/entities, circuit-breaker-stuck entities, cursor drift,
 * paused streams, incomplete backfills, and whether the index that the
 * global cron-ingest query relies on actually exists.
 *
 * Safety
 * ------
 * - STRICTLY read-only: only count / find / aggregate / listIndexes are used.
 * - Connects to DATABASE_URL. To point at prod, run with the prod URI
 *   exported, e.g.:
 *       DATABASE_URL="$PROD_DATABASE_URL" \
 *         pnpm --filter api exec tsx src/scripts/cdc-pending-diagnostic.ts
 *
 * Usage
 * -----
 *   pnpm --filter api exec tsx src/scripts/cdc-pending-diagnostic.ts
 */
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const TOP_N = Number(process.env.CDC_DIAG_TOP_N || 20);

function fmtAge(date: Date | null | undefined): string {
  if (!date) return "n/a";
  const ms = Date.now() - new Date(date).getTime();
  const min = ms / 60000;
  if (min < 60) return `${min.toFixed(1)}m`;
  const hrs = min / 60;
  if (hrs < 48) return `${hrs.toFixed(1)}h`;
  return `${(hrs / 24).toFixed(1)}d`;
}

function header(title: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

async function main(): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("No DATABASE_URL set. Aborting.");
    process.exit(1);
  }

  let dbName = "(unknown)";
  try {
    dbName = new URL(uri).pathname.replace(/^\//, "").split("?")[0] || "(none)";
  } catch {
    /* non-standard uri */
  }

  console.log(`Connecting to db="${dbName}" (read-only diagnostic)...`);
  await mongoose.connect(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8000,
  });
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle after connect");

  const webhooks = db.collection("webhookevents");
  const cdc = db.collection("cdc_change_events");
  const entityState = db.collection("cdc_entity_state");
  const flows = db.collection("flows");

  // ---- 1. WebhookEvent status distribution -----------------------------
  header("1. WebhookEvent.status distribution (ingest backlog)");
  const whByStatus = await webhooks
    .aggregate([
      { $group: { _id: "$status", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  for (const r of whByStatus)
    console.log(`  ${String(r._id).padEnd(12)} ${r.n}`);

  const oldestPending = await webhooks
    .find({ status: "pending" })
    .sort({ receivedAt: 1 })
    .limit(1)
    .project({ receivedAt: 1 })
    .toArray();
  if (oldestPending[0]) {
    console.log(
      `  oldest pending received: ${new Date(
        oldestPending[0].receivedAt,
      ).toISOString()} (age ${fmtAge(oldestPending[0].receivedAt)})`,
    );
  }

  header("1b. Top flows by pending WebhookEvents");
  const whPendingByFlow = await webhooks
    .aggregate([
      { $match: { status: "pending" } },
      {
        $group: {
          _id: "$flowId",
          n: { $sum: 1 },
          oldest: { $min: "$receivedAt" },
        },
      },
      { $sort: { n: -1 } },
      { $limit: TOP_N },
    ])
    .toArray();
  for (const r of whPendingByFlow) {
    console.log(
      `  flow ${String(r._id)}  pending=${r.n}  oldest=${fmtAge(r.oldest)}`,
    );
  }

  // ---- 2. Orphaned apply (completed ingest, apply never finalized) ------
  header("2. WebhookEvents completed-but-apply-pending (orphaned apply)");
  const orphanApply = await webhooks.countDocuments({
    status: "completed",
    applyStatus: "pending",
  });
  const orphanApplyStale = await webhooks.countDocuments({
    status: "completed",
    applyStatus: "pending",
    receivedAt: { $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
  });
  console.log(`  status=completed & applyStatus=pending : ${orphanApply}`);
  console.log(
    `    of which older than 7d (reapable)     : ${orphanApplyStale}`,
  );

  // ---- 3. CdcChangeEvent materialization distribution -------------------
  header("3. CdcChangeEvent.materializationStatus distribution");
  const cdcByStatus = await cdc
    .aggregate([
      { $group: { _id: "$materializationStatus", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  for (const r of cdcByStatus)
    console.log(`  ${String(r._id).padEnd(12)} ${r.n}`);

  header("3b. Top flow+entity by pending CdcChangeEvents");
  const cdcPendingByEntity = await cdc
    .aggregate([
      { $match: { materializationStatus: "pending" } },
      {
        $group: {
          _id: { flowId: "$flowId", entity: "$entity" },
          n: { $sum: 1 },
          oldest: { $min: "$ingestTs" },
          minSeq: { $min: "$ingestSeq" },
          maxSeq: { $max: "$ingestSeq" },
        },
      },
      { $sort: { n: -1 } },
      { $limit: TOP_N },
    ])
    .toArray();
  for (const r of cdcPendingByEntity) {
    console.log(
      `  flow ${String(r._id.flowId)} entity=${r._id.entity} pending=${r.n} ` +
        `seq=[${r.minSeq}..${r.maxSeq}] oldest=${fmtAge(r.oldest)}`,
    );
  }

  // ---- 4. Circuit-breaker-stuck entities --------------------------------
  header("4. Entities tripping the circuit breaker (consecutiveFailures > 0)");
  const failing = await entityState
    .find({ consecutiveFailures: { $gt: 0 } })
    .project({
      flowId: 1,
      entity: 1,
      consecutiveFailures: 1,
      lastFailedAt: 1,
      lastFailureError: 1,
    })
    .sort({ consecutiveFailures: -1 })
    .limit(TOP_N)
    .toArray();
  if (failing.length === 0) console.log("  (none)");
  for (const r of failing) {
    console.log(
      `  flow ${String(r.flowId)} entity=${r.entity} fails=${r.consecutiveFailures} ` +
        `lastFailed=${fmtAge(r.lastFailedAt)}\n      err: ${String(
          r.lastFailureError || "",
        ).slice(0, 160)}`,
    );
  }

  // ---- 5. Cursor drift --------------------------------------------------
  header("5. Cursor state (lastIngestSeq vs lastMaterializedSeq)");
  const staleCursors = await entityState.countDocuments({
    $expr: { $gt: ["$lastIngestSeq", "$lastMaterializedSeq"] },
  });
  const driftedCursors = await entityState
    .find({ $expr: { $lt: ["$lastIngestSeq", "$lastMaterializedSeq"] } })
    .project({ flowId: 1, entity: 1, lastIngestSeq: 1, lastMaterializedSeq: 1 })
    .limit(TOP_N)
    .toArray();
  console.log(
    `  entities behind (lastIngestSeq > lastMaterializedSeq): ${staleCursors}`,
  );
  console.log(
    `  entities with cursor AHEAD of ingest (drift): ${driftedCursors.length}`,
  );
  for (const r of driftedCursors) {
    console.log(
      `    flow ${String(r.flowId)} entity=${r.entity} ingestSeq=${r.lastIngestSeq} matSeq=${r.lastMaterializedSeq}`,
    );
  }

  // ---- 5b. THE TRAP: pending rows at/below the consumer cursor ----------
  // This is the decisive query. A pending CdcChangeEvent whose ingestSeq is
  // <= its entity's lastMaterializedSeq is INVISIBLE to the (pre-fix) reader
  // (readAfter gated on ingestSeq > cursor) AND, if lastIngestSeq == cursor,
  // UNTRIGGERED by findStaleEntities ($gt). Those two together = stuck forever.
  // If this count is large for your stuck entities, the cursor-drift trap is
  // PROVEN regardless of which seed first advanced the cursor.
  header("5b. Orphaned-below-cursor pending (THE trap) — top entities");
  let totalOrphanedBelowCursor = 0;
  let invisibleAndUntriggered = 0;
  for (const r of cdcPendingByEntity) {
    const flowId = r._id.flowId;
    const entity = r._id.entity;
    const st = await entityState.findOne(
      { flowId, entity },
      { projection: { lastMaterializedSeq: 1, lastIngestSeq: 1 } },
    );
    const cursor = Number(st?.lastMaterializedSeq || 0);
    const ingest = Number(st?.lastIngestSeq || 0);
    const belowCursor = await cdc.countDocuments({
      flowId,
      entity,
      materializationStatus: "pending",
      ingestSeq: { $lte: cursor },
    });
    if (belowCursor <= 0) continue;
    totalOrphanedBelowCursor += belowCursor;
    // Would the scheduler ever re-fire this entity? Only if lastIngestSeq > cursor.
    const triggered = ingest > cursor;
    if (!triggered) invisibleAndUntriggered += belowCursor;
    // What produced the orphaned rows? webhook vs backfill discriminates the seed.
    const bySource = await cdc
      .aggregate([
        {
          $match: {
            flowId,
            entity,
            materializationStatus: "pending",
            ingestSeq: { $lte: cursor },
          },
        },
        {
          $group: {
            _id: "$source",
            n: { $sum: 1 },
            oldest: { $min: "$ingestTs" },
            newest: { $max: "$ingestTs" },
          },
        },
      ])
      .toArray();
    const srcStr = bySource
      .map(
        s =>
          `${s._id || "?"}=${s.n} (${fmtAge(s.oldest)}..${fmtAge(s.newest)})`,
      )
      .join(", ");
    console.log(
      `  flow ${String(flowId)} entity=${entity} ` +
        `belowCursor=${belowCursor}/${r.n} cursor=${cursor} ingest=${ingest} ` +
        `${triggered ? "(triggered)" : "INVISIBLE+UNTRIGGERED"}\n      src: ${srcStr}`,
    );
  }
  console.log(
    `  TOTAL orphaned-below-cursor pending (top ${TOP_N}) : ${totalOrphanedBelowCursor}`,
  );
  console.log(
    `  of which invisible AND untriggered (truly stuck)  : ${invisibleAndUntriggered}`,
  );

  // ---- 5c. Seed discrimination: backfill timing vs orphaned rows --------
  // If the orphaned pending rows are source="webhook" and their ingestTs sits
  // inside/just-before a COMPLETED backfill window for the same flow, the most
  // likely seed is backfill advancing lastMaterializedSeq past them (seed #2).
  header("5c. Backfill timing for flows with pending CdcChangeEvents");
  const flowIdsWithPending = Array.from(
    new Set(cdcPendingByEntity.map(r => String(r._id.flowId))),
  );
  for (const fidStr of flowIdsWithPending.slice(0, TOP_N)) {
    const f = await flows.findOne(
      { _id: new mongoose.Types.ObjectId(fidStr) },
      {
        projection: {
          name: 1,
          streamState: 1,
          backfillState: 1,
          deleteMode: 1,
        },
      },
    );
    if (!f) continue;
    const bf = (f as any).backfillState || {};
    console.log(
      `  flow ${fidStr} "${(f as any).name ?? ""}" stream=${
        (f as any).streamState
      } backfill.status=${bf.status ?? "n/a"} ` +
        `started=${fmtAge(bf.startedAt)} completed=${fmtAge(bf.completedAt)}`,
    );
  }

  // ---- 6. Paused streams / incomplete backfills -------------------------
  header("6. Flow states blocking the consumer");
  const pausedStreams = await flows.countDocuments({
    syncEngine: "cdc",
    streamState: "paused",
  });
  const incompleteBackfills = await flows.countDocuments({
    syncEngine: "cdc",
    "backfillState.runId": { $exists: true, $ne: null },
  });
  console.log(`  CDC flows with streamState=paused      : ${pausedStreams}`);
  console.log(
    `  CDC flows with incomplete backfill runId: ${incompleteBackfills}`,
  );

  // ---- 7. Index coverage check for the global cron-ingest query ---------
  header(
    "7. Index coverage for cron-ingest query find({status}).sort({receivedAt})",
  );
  const whIndexes = await webhooks.listIndexes().toArray();
  const idxKeys = whIndexes.map(i => JSON.stringify(i.key));
  const hasStatusReceivedAt = whIndexes.some(i => {
    const k = i.key as Record<string, number>;
    const keys = Object.keys(k);
    return keys[0] === "status" && keys[1] === "receivedAt";
  });
  console.log(`  webhookevents indexes: ${idxKeys.join(", ")}`);
  console.log(
    hasStatusReceivedAt
      ? "  OK: { status: 1, receivedAt: 1 } index present."
      : "  MISSING: no { status, receivedAt } index -> the every-5-min global\n" +
          "    ingest query does a COLLSCAN + in-memory sort over webhookevents.",
  );

  // ---- explain the global ingest query ---------------------------------
  try {
    const explain = await webhooks
      .find({ status: "pending" })
      .sort({ receivedAt: 1 })
      .limit(1000)
      .explain("queryPlanner");
    const winning = JSON.stringify(
      (explain as any)?.queryPlanner?.winningPlan || {},
    );
    const isCollScan = /COLLSCAN/.test(winning);
    console.log(
      `  winning plan: ${isCollScan ? "COLLSCAN (BAD)" : "IXSCAN (ok)"}`,
    );
  } catch (e) {
    console.log(`  explain failed: ${(e as Error).message}`);
  }

  header("VERDICT");
  const pendingWh = whByStatus.find(r => r._id === "pending")?.n || 0;
  const pendingCdc = cdcByStatus.find(r => r._id === "pending")?.n || 0;
  console.log(`  pending WebhookEvents (ingest backlog) : ${pendingWh}`);
  console.log(`  pending CdcChangeEvents (mat. backlog) : ${pendingCdc}`);
  console.log(
    `  >> orphaned-below-cursor pending       : ${totalOrphanedBelowCursor}  <-- the trap`,
  );
  console.log(
    `  >> invisible AND untriggered           : ${invisibleAndUntriggered}  <-- stuck forever`,
  );
  console.log(`  circuit-breaker-stuck entities         : ${failing.length}`);
  console.log(
    `  drifted cursors (ingest<cursor)        : ${driftedCursors.length}`,
  );
  console.log(
    `  paused streams / incomplete backfills  : ${pausedStreams} / ${incompleteBackfills}`,
  );
  console.log("\nInterpretation:");
  console.log(
    "  - Big & growing pending WebhookEvents -> ingest throughput-bound",
  );
  console.log(
    "    (cron */5, concurrency 1, batch 1000) and/or missing index.",
  );
  console.log("  - Big pending CdcChangeEvents + failing entities -> real");
  console.log("    materialization errors held off by the circuit breaker.");
  console.log(
    "  - Drifted cursors -> orphaned pending; needs reprocess/force-drain.",
  );
  console.log("  - Paused/backfilling flows -> consumer intentionally skips.");

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error("Diagnostic failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
