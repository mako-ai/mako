/**
 * Migrate legacy-engine connector flows onto the CDC engine (Phase 5).
 *
 * Dry-run by default — prints a per-flow migration plan (migrate / skip /
 * blocked with reasons) without touching anything. Apply with --apply.
 *
 *   pnpm --filter api exec tsx src/scripts/migrate-legacy-flows-to-cdc.ts
 *   pnpm --filter api exec tsx src/scripts/migrate-legacy-flows-to-cdc.ts --apply
 *
 * After applying, run an initial backfill per migrated flow (UI "Re-run"
 * backfill, or POST .../flows/:id/sync-cdc/backfill/start) to seed the CDC
 * live tables before relying on incremental polls.
 */
/* eslint-disable no-console */
import "dotenv/config";
import mongoose from "mongoose";
import {
  planLegacyFlowMigration,
  type MigrationDecision,
} from "../sync/legacy-flow-migration";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const { Flow, DatabaseConnection, Connector } = await import(
    "../database/workspace-schema"
  );
  const { databaseRegistry } = await import("../databases/registry");
  // Driver registration normally happens in index.ts; load the ones whose
  // capabilities the planner consults.
  const { BigQueryDatabaseDriver } = await import(
    "../databases/drivers/bigquery/driver"
  );
  if (!databaseRegistry.getDriver("bigquery")) {
    databaseRegistry.register(new BigQueryDatabaseDriver());
  }

  const candidates = await Flow.find({
    sourceType: { $ne: "database" },
    syncEngine: { $ne: "cdc" },
  }).lean();

  console.log(
    `\nFound ${candidates.length} legacy connector flow(s) to evaluate${apply ? " (APPLY MODE)" : " (dry run — pass --apply to write)"}\n`,
  );

  const decisions: MigrationDecision[] = [];
  for (const flow of candidates) {
    const destinationId =
      flow.tableDestination?.connectionId || flow.destinationDatabaseId;
    // No .lean(): the `connection` field is encrypted at rest and decrypted
    // by a Mongoose getter, which lean() would bypass.
    const destination = destinationId
      ? await DatabaseConnection.findById(destinationId)
      : null;
    const source = flow.dataSourceId
      ? await Connector.findById(flow.dataSourceId).select({ name: 1 }).lean()
      : null;

    const driver = destination
      ? databaseRegistry.getDriver(destination.type)
      : undefined;
    const decision = planLegacyFlowMigration(
      { ...flow, _id: String(flow._id) } as any,
      destination
        ? {
            type: destination.type,
            databaseName: (destination.connection as any)?.database,
            requiresSoftDeleteForCdc: Boolean(
              driver?.requiresSoftDeleteForCdc?.(),
            ),
          }
        : null,
      source ? { name: (source as any).name } : null,
    );
    decisions.push(decision);

    const label = `${String(flow._id)} [dest=${destination?.type ?? "?"}, mode=${flow.syncMode}, schedule=${flow.schedule?.enabled ? flow.schedule?.cron : "off"}]`;
    if (decision.action === "migrate") {
      console.log(`MIGRATE ${label}`);
      for (const note of decision.notes) console.log(`    - ${note}`);
      if (apply) {
        await Flow.updateOne(
          { _id: flow._id },
          { $set: decision.updates as Record<string, unknown> },
        );
        console.log("    ✓ applied");
      }
    } else if (decision.action === "blocked") {
      console.log(`BLOCKED ${label}\n    - ${decision.reason}`);
    } else {
      console.log(`SKIP    ${label}\n    - ${decision.reason}`);
    }
  }

  const counts = decisions.reduce(
    (acc, d) => ({ ...acc, [d.action]: (acc as any)[d.action] + 1 }),
    { migrate: 0, skip: 0, blocked: 0 },
  );
  console.log(
    `\nSummary: ${counts.migrate} migrate, ${counts.skip} skip, ${counts.blocked} blocked.`,
  );
  if (apply && counts.migrate > 0) {
    console.log(
      "Next step: run an initial CDC backfill per migrated flow to seed the live tables.",
    );
  }

  await mongoose.disconnect();
  // Module side effects (model registration, pooled clients) can keep the
  // event loop alive; this is a one-shot CLI, so exit explicitly.
  process.exit(0);
}

main().catch(err => {
  console.error("[migrate-legacy-flows-to-cdc] failed:", err);
  process.exit(1);
});
