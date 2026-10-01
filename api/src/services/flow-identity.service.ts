/**
 * A flow's name and its slug (apps.md §25 / RFC #904).
 *
 * Flows shipped without a name: the UI derived a label from the source and
 * destination connection names at render time. That works for a list row and
 * fails for config-as-code — `flows/<slug>.yml` needs an identity that does
 * NOT move when someone renames a connection.
 *
 * So, following the dbt jobs rule (§23):
 * - `slug` is minted ONCE at creation and never changes. It is the filename.
 * - `name` is the editable display name, and lives inside the file.
 *
 * `deriveFlowDisplayName` remains the fallback for rows created before this
 * (and the seed for their backfilled names): it is the same
 * "source → destination" derivation the scheduler logged, extracted here so
 * runtime, routes and the migration share one copy.
 */
import { Types } from "mongoose";

import {
  SourceConnection,
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../database/workspace-schema";
import { reserveSlug, slugifyName } from "../utils/slugify";

/** The `source → destination` label flows have always shown. */
export async function deriveFlowDisplayName(
  flow: Pick<
    IFlow,
    | "sourceType"
    | "databaseSource"
    | "dataSourceId"
    | "tableDestination"
    | "destinationDatabaseId"
  >,
): Promise<string> {
  try {
    let sourceName: string;
    let destName: string;

    if (flow.sourceType === "database" && flow.databaseSource?.connectionId) {
      const sourceDb = await DatabaseConnection.findById(
        flow.databaseSource.connectionId,
      );
      sourceName =
        sourceDb?.name || flow.databaseSource.connectionId.toString();
    } else if (flow.dataSourceId) {
      const sourceConnection = await SourceConnection.findById(
        flow.dataSourceId,
      );
      sourceName = sourceConnection?.name || flow.dataSourceId.toString();
    } else {
      sourceName = "Unknown Source";
    }

    if (flow.tableDestination?.connectionId) {
      const destDb = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      destName = flow.tableDestination.tableName
        ? `${destDb?.name || "DB"}.${flow.tableDestination.tableName}`
        : destDb?.name || flow.tableDestination.connectionId.toString();
    } else {
      const database = await DatabaseConnection.findById(
        flow.destinationDatabaseId,
      );
      destName = database?.name || flow.destinationDatabaseId.toString();
    }

    return `${sourceName} → ${destName}`;
  } catch {
    // Fallback to ids if a lookup fails — a name is never worth a 500.
    const sourceId =
      flow.sourceType === "database"
        ? flow.databaseSource?.connectionId?.toString()
        : flow.dataSourceId?.toString();
    return `${sourceId || "Unknown"} → ${flow.destinationDatabaseId}`;
  }
}

/**
 * The name to SHOW: the stored one once a flow has it, else the derivation
 * (rows created before names existed, until the backfill stamps them).
 */
export async function flowDisplayName(
  flow: Pick<
    IFlow,
    | "name"
    | "sourceType"
    | "databaseSource"
    | "dataSourceId"
    | "tableDestination"
    | "destinationDatabaseId"
  >,
): Promise<string> {
  return flow.name?.trim() || (await deriveFlowDisplayName(flow));
}

/** `Stripe → Warehouse` slugs to `stripe-warehouse`. */
export function slugifyFlowName(name: string): string {
  return slugifyName(name, { fallback: "flow" });
}

/**
 * Reserve a slug unique within the workspace. Called once per flow, at
 * creation (or by the backfill); never on rename.
 */
export async function reserveFlowSlug(
  workspaceId: Types.ObjectId | string,
  name: string,
  /**
   * Slugs already taken by files at main that have no row yet. Mongo rows
   * alone are not the identity space: a name that slugifies onto a git-only
   * `flows/<slug>.yml` would otherwise overwrite that file under a second id.
   */
  takenAtMain: ReadonlySet<string> = new Set(),
): Promise<string> {
  const wsId =
    typeof workspaceId === "string"
      ? new Types.ObjectId(workspaceId)
      : workspaceId;
  return reserveSlug(
    slugifyFlowName(name),
    async candidate =>
      takenAtMain.has(candidate) ||
      Boolean(await Flow.exists({ workspaceId: wsId, slug: candidate })),
    { label: `flow "${name}"` },
  );
}
