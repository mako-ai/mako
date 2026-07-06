import { Db } from "mongodb";
import {
  planLegacyFlowMigration,
  type MigrationFlowInput,
} from "../sync/legacy-flow-migration";
import { decrypt } from "../database/workspace-schema";
import { loggers } from "../logging";

export const description =
  "Big-bang: migrate legacy-engine connector flows onto the CDC engine (full scheduled sync → periodic reconcile, incremental → CDC poll, Mongo destinations get a synthesized tableDestination)";

const log = loggers.migration();

/**
 * Destination types whose CDC MERGE path relies on soft-delete tombstones.
 * Mirrors `requiresSoftDeleteForCdc()` on the BigQuery driver — the planner
 * is dependency-free, and importing driver classes here would drag heavy
 * SDK imports into the migration runner.
 */
const SOFT_DELETE_DESTINATION_TYPES = new Set(["bigquery"]);

/**
 * `connection.database` is AES-encrypted at rest; the Mongoose getter usually
 * decrypts it, but migrations read via the raw driver. Decrypt when the value
 * matches the `iv:payload` hex format, otherwise use it as-is.
 */
function resolveDestinationDatabaseName(destination: {
  connection?: unknown;
}): string | undefined {
  const raw = (destination.connection as { database?: unknown } | undefined)
    ?.database;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(raw)) {
    try {
      return decrypt(raw);
    } catch {
      return undefined;
    }
  }
  return raw;
}

export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");
  const connections = db.collection("databaseconnections");
  const connectors = db.collection("connectors");

  // Idempotent: only legacy-engine connector flows are candidates; already
  // migrated (syncEngine=cdc) flows are skipped by the planner.
  const candidates = await flows
    .find({
      sourceType: { $ne: "database" },
      syncEngine: { $ne: "cdc" },
    })
    .toArray();

  let migrated = 0;
  let blocked = 0;
  let skipped = 0;

  for (const flow of candidates) {
    const destinationId =
      flow.tableDestination?.connectionId || flow.destinationDatabaseId;
    const destination = destinationId
      ? await connections.findOne({ _id: destinationId })
      : null;
    const source = flow.dataSourceId
      ? await connectors.findOne(
          { _id: flow.dataSourceId },
          { projection: { name: 1 } },
        )
      : null;

    const decision = planLegacyFlowMigration(
      { ...flow, _id: String(flow._id) } as unknown as MigrationFlowInput,
      destination
        ? {
            type: destination.type,
            databaseName: resolveDestinationDatabaseName(
              destination as { connection?: unknown },
            ),
            requiresSoftDeleteForCdc: SOFT_DELETE_DESTINATION_TYPES.has(
              String(destination.type).toLowerCase(),
            ),
          }
        : null,
      source ? { name: source.name } : null,
    );

    if (decision.action === "migrate") {
      await flows.updateOne(
        { _id: flow._id },
        { $set: decision.updates as Record<string, unknown> },
      );
      migrated += 1;
      log.info("Migrated legacy flow to CDC", {
        flowId: String(flow._id),
        notes: decision.notes,
      });
    } else if (decision.action === "blocked") {
      blocked += 1;
      // Blocked flows keep running on the legacy engine (code path retained)
      // — surface loudly so they get handled manually.
      log.warn("Legacy flow NOT migrated to CDC", {
        flowId: String(flow._id),
        reason: decision.reason,
      });
    } else {
      skipped += 1;
    }
  }

  log.info("Legacy→CDC flow migration complete", {
    candidates: candidates.length,
    migrated,
    blocked,
    skipped,
  });
}
