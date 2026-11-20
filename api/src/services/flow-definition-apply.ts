/**
 * Mapping a parsed `flows/<slug>.yml` onto its Flow row, and the row-side
 * bookkeeping that goes with it: the invalid-definition marker, the id of a
 * file that has no row yet, and the one-time webhook endpoint for a file-born
 * webhook flow. Shared by the push reactor and the live read overlay
 * (flow-sync.service.ts) and by the file checker.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { Flow, type IFlow } from "../database/workspace-schema";
import { loggers } from "../logging";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import type { FlowFile } from "./flow-config-files";
import { resyncLastRunAt } from "./resync-schedule";

const logger = loggers.api("flow-sync");

/**
 * The inbound URL a file-born webhook flow needs, or null when none should be
 * minted.
 *
 * `applyDefinition` writes only `webhookConfig.enabled`, because the endpoint
 * is inbound URL identity and the secret is a credential — neither belongs in
 * a file and an EDIT must move neither. That is right for an update and left a
 * CREATE broken: a file-born webhook flow saved with `enabled: true` and no
 * endpoint has nowhere for Stripe to POST. It looks configured and receives
 * nothing, and webhook is the majority case (17 of 31 production flows).
 *
 * So the endpoint is minted exactly once, when the row is first created, and
 * derived from `workspaceId` + the flow's `_id` — never from the slug, so
 * editing a file cannot move it.
 *
 * THE SECRET IS DELIBERATELY NOT MINTED. It is the provider's signing secret
 * (Stripe's `whsec_...`), handed to `connector.verifyWebhook` by
 * routes/webhooks.ts. A value invented here would fail signature verification
 * on every real delivery while the flow looked fully configured — strictly
 * worse than the empty string, which at least fails honestly. It arrives from
 * the user, or from the Stripe-managed path that stores `signingSecret`
 * returned by Stripe's own API.
 *
 * On renames: a renamed FILE is a different flow by construction — the slug is
 * identity and this module matches on it, so a new slug finds no row and mints
 * its own endpoint. Changing a flow's `name:` does not move the file, so that
 * row and its endpoint are untouched. Preserving an inbound URL across a file
 * rename would need identity inside the file, and is a separate change.
 */
export function mintedWebhookEndpoint(args: {
  isNew: boolean;
  /** The file's `webhook.enabled` (undefined when it has no stanza). */
  webhookEnabled?: boolean;
  workspaceId: string;
  flowId: string;
  existingEndpoint?: string;
}): string | null {
  // Never overwrite one that already exists: providers POST to it.
  if (args.existingEndpoint) return null;
  // A new webhook flow, or any flow whose file switches webhooks on (a
  // scheduled flow keeps polling and gets webhooks on top).
  const wanted = args.webhookEnabled === true;
  if (!wanted) return null;
  return generateWebhookEndpoint(args.workspaceId, args.flowId);
}

/**
 * Mongoose materialises an unset nested path as `{}` on a hydrated doc, so
 * the marker's presence is its `reason`, never the object's truthiness —
 * `if (row.definitionInvalid)` read every healthy flow as invalid, which is
 * how a bound workspace's runs came to re-parse their file on every fire and
 * an unbound one's runs were refused outright.
 */
export function isFlowMarkedInvalid(row: {
  definitionInvalid?: { reason?: string } | null;
}): boolean {
  return typeof row.definitionInvalid?.reason === "string";
}

/** The row's marker when it is a real one (see isFlowMarkedInvalid). */
export function rowInvalidMarker(
  row: IFlow | null,
): IFlow["definitionInvalid"] | undefined {
  return row && isFlowMarkedInvalid(row) ? row.definitionInvalid : undefined;
}

/** Assigning `undefined` to a nested path persists `{}`; unset it instead. */
export async function clearFlowInvalid(id: Types.ObjectId): Promise<void> {
  await Flow.updateOne({ _id: id }, { $unset: { definitionInvalid: 1 } });
}

/**
 * Stamp the marker (and pause the schedules) with a targeted update, never
 * a `save()`: a legacy row that no longer passes the schema would throw out
 * of the push-sync loop and skip every file after it. Idempotent, so a list
 * call does not rewrite the marker on every read.
 */
export async function markFlowInvalid(
  doc: IFlow,
  reason: string,
  path: string,
): Promise<void> {
  if (
    doc.definitionInvalid?.reason === reason &&
    doc.definitionInvalid?.path === path
  ) {
    return;
  }
  const definitionInvalid = { reason, at: new Date(), path };
  const set: Record<string, unknown> = { definitionInvalid };
  if (doc.schedule) set["schedule.enabled"] = false;
  if (doc.backfillSchedule) set["backfillSchedule.enabled"] = false;
  try {
    await Flow.updateOne({ _id: doc._id }, { $set: set });
    doc.definitionInvalid = definitionInvalid;
    if (doc.schedule) doc.schedule.enabled = false;
    if (doc.backfillSchedule) doc.backfillSchedule.enabled = false;
  } catch (error) {
    logger.warn("Failed to mark flow invalid", {
      flowId: doc._id.toString(),
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stable id for a flow that exists as `flows/<slug>.yml` but has no index
 * row yet (same contract as `derivedConsoleId` / `derivedAppId`).
 */
export function derivedFlowId(
  workspaceId: string,
  slug: string,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`flows:${workspaceId}:${slug}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/**
 * Apply the definition half of a parsed file onto a row. Runtime untouched.
 *
 * Returns a reason when the file cannot be applied, so the caller keeps the
 * current row rather than half-writing one.
 */
export function applyDefinition(doc: IFlow, file: FlowFile): string | null {
  doc.name = file.name;
  // `type` is retired: never written (a file's `type: webhook` arrives here
  // as webhookEnabled, see parseFlowFile).

  if (file.source.type === "database") {
    doc.sourceType = "database";
    doc.databaseSource = {
      ...(doc.databaseSource ?? {}),
      connectionId: file.source.connectionId
        ? new Types.ObjectId(file.source.connectionId)
        : undefined,
      database: file.source.database,
      query: file.source.query,
    } as IFlow["databaseSource"];
  } else {
    // `dataSourceId` is required on the schema, so a connector file without
    // one cannot produce a valid row. Refuse the file rather than write half
    // a flow — the row that exists is more trustworthy than a bad edit.
    if (!file.source.connectionId) {
      return "connector source has no connection_id";
    }
    doc.sourceType = "connector";
    doc.dataSourceId = new Types.ObjectId(file.source.connectionId);
  }

  // Required on the schema, same as `dataSourceId` above: refuse rather than
  // write a row with no destination.
  if (!file.destination.connectionId) {
    return "destination has no connection_id";
  }
  doc.destinationDatabaseId = new Types.ObjectId(file.destination.connectionId);
  doc.destinationDatabaseName = file.destination.databaseName;
  if (file.destination.table) {
    const t = file.destination.table;
    doc.tableDestination = {
      ...(doc.tableDestination ?? {}),
      connectionId: t.connectionId
        ? new Types.ObjectId(t.connectionId)
        : undefined,
      database: t.database,
      schema: t.schema,
      tableName: t.tableName,
      createIfNotExists: t.createIfNotExists,
      partitioning: t.partitioning,
      clustering: t.clustering,
    } as IFlow["tableDestination"];
  }

  // Schedules: cron + timezone only. `backfillSchedule.lastRunAt` is a
  // scheduler claim (`isCronDue` reads it) and survives a file edit that
  // leaves the resync timing alone. A new, changed or re-enabled resync
  // starts counting now, so it first runs at its next tick (resync-schedule.ts).
  const resyncBefore = doc.backfillSchedule
    ? {
        enabled: doc.backfillSchedule.enabled,
        cron: doc.backfillSchedule.cron,
        timezone: doc.backfillSchedule.timezone,
        lastRunAt: doc.backfillSchedule.lastRunAt,
      }
    : undefined;
  doc.schedule = {
    ...(doc.schedule ?? {}),
    enabled: Boolean(file.schedule),
    cron: file.schedule?.cron,
    timezone: file.schedule?.timezone,
  } as IFlow["schedule"];
  doc.backfillSchedule = {
    ...(doc.backfillSchedule ?? {}),
    enabled: Boolean(file.backfillSchedule),
    cron: file.backfillSchedule?.cron,
    timezone: file.backfillSchedule?.timezone,
    entities: file.backfillSchedule?.entities,
    lastRunAt: resyncLastRunAt(resyncBefore, {
      enabled: Boolean(file.backfillSchedule),
      cron: file.backfillSchedule?.cron,
      timezone: file.backfillSchedule?.timezone,
    }),
  } as IFlow["backfillSchedule"];

  // Enabled-ness and the provider subscription id. The endpoint is inbound
  // URL identity minted once in Mongo (17 of 31 production flows have
  // external systems POSTing to it) and the secret is a credential; neither
  // is in the file and neither may be touched from here.
  if (file.webhookEnabled !== undefined) {
    doc.webhookConfig = {
      ...(doc.webhookConfig ?? {}),
      enabled: file.webhookEnabled !== false,
      // The provider subscription id is definition, not identity: the file
      // owns it.
      providerWebhookId: file.webhookProviderId,
    } as IFlow["webhookConfig"];
  }

  doc.syncMode = file.sync.mode as IFlow["syncMode"];
  doc.writeMode = file.sync.writeMode as IFlow["writeMode"];
  // CDC is the only engine for connector flows: a file saying otherwise (or
  // nothing) still yields CDC, so a flow can never be born on the removed
  // legacy engine from a file.
  doc.syncEngine =
    doc.sourceType === "database"
      ? (file.sync.engine as IFlow["syncEngine"])
      : "cdc";
  doc.deleteMode = file.sync.deleteMode as IFlow["deleteMode"];
  if (file.sync.batchSize !== undefined) doc.batchSize = file.sync.batchSize;

  doc.entityFilter = file.entityFilter as IFlow["entityFilter"];
  doc.entityLayouts = file.entityLayouts as unknown as IFlow["entityLayouts"];
  doc.typeCoercions = file.typeCoercions as unknown as IFlow["typeCoercions"];
  doc.queries = file.queries as unknown as IFlow["queries"];

  // Definition halves only — merge onto the existing object so the cursors
  // (`lastValue`, `lastKeysetValue`) are preserved rather than dropped.
  if (file.incremental) {
    doc.incrementalConfig = {
      ...(doc.incrementalConfig ?? {}),
      trackingColumn: file.incremental.trackingColumn,
      trackingType: file.incremental.trackingType,
    } as IFlow["incrementalConfig"];
  }
  if (file.pagination) {
    doc.paginationConfig = {
      ...(doc.paginationConfig ?? {}),
      mode: file.pagination.mode,
      keysetColumn: file.pagination.keysetColumn,
      keysetDirection: file.pagination.keysetDirection,
    } as IFlow["paginationConfig"];
  }
  if (file.conflict) {
    doc.conflictConfig = {
      ...(doc.conflictConfig ?? {}),
      keyColumns: file.conflict.keyColumns,
      strategy: file.conflict.strategy,
    } as IFlow["conflictConfig"];
  }
  return null;
}

/** Why a parsed file cannot become a row — refusal or schema, same as save(). */
export function flowFileApplyFailure(
  file: FlowFile,
  args: { workspaceId: string; slug: string; createdBy: string },
): string | null {
  const hydrated = hydrateFlowRow(file, args);
  if (hydrated.refusal) return hydrated.refusal;
  if (hydrated.schemaErrors.length === 0) return null;
  return hydrated.schemaErrors.map(e => `${e.path}: ${e.message}`).join("; ");
}

/** What a file would produce if it were written onto a fresh row. */
export interface HydratedFlowRow {
  /** Set when `applyDefinition` refuses the file outright. */
  refusal: string | null;
  /** Field-level schema failures, as mongoose would raise them on save. */
  schemaErrors: Array<{ path: string; message: string }>;
  /** The unsaved row, when the file applied. */
  doc?: IFlow;
}

/**
 * Build the row a file would produce and ask the model whether it is valid —
 * WITHOUT saving it.
 *
 * The third validation layer, and the one nothing else covers. Parsing and
 * referential resolution (`flow-validate.service.ts`) both pass for a file
 * whose `entities.layouts` entry has no `partition_field`, or whose
 * `sync.write_mode` is outside the schema's enum; `doc.save()` in the push
 * reactor then throws and the row is never written. A checker that certifies
 * a file the reactor refuses is the silent-no-op failure the RFC exists to
 * end, one layer further in.
 *
 * Uses the reactor's own `applyDefinition` rather than a second mapping, so
 * the check cannot disagree with what it is predicting.
 *
 * `createdBy` is required on the schema and is not in the file (it is the
 * acting user, supplied by the reactor); callers checking a file rather than
 * creating one pass a placeholder so the check reports the file's problems
 * and not that one.
 */
export function hydrateFlowRow(
  file: FlowFile,
  args: { workspaceId: string; slug: string; createdBy: string },
): HydratedFlowRow {
  const doc = new Flow({
    workspaceId: new Types.ObjectId(args.workspaceId),
    slug: args.slug,
    createdBy: args.createdBy,
  }) as unknown as IFlow;

  let refusal: string | null;
  try {
    refusal = applyDefinition(doc, file);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (refusal) return { refusal, schemaErrors: [] };

  // validateSync() runs the schema's own validators in-process and touches no
  // connection — the document is never saved and this function never writes.
  const error = (
    doc as unknown as {
      validateSync: () =>
        { errors?: Record<string, { message?: string }> } | undefined;
    }
  ).validateSync();
  const errors = error?.errors ?? {};
  return {
    refusal: null,
    schemaErrors: Object.entries(errors).map(([path, err]) => ({
      path,
      message: err?.message ?? "is invalid",
    })),
    doc,
  };
}
