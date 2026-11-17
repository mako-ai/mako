/**
 * Webhook batches for workspace (boxed) connectors.
 *
 * Trust boundaries, in the order an event crosses them:
 *
 * 1. Ingress (routes/webhooks.ts). The API verifies the delivery with the
 *    flow's signing secret against the scheme the connector declared as data
 *    (webhook-verification.ts), then stores it with `lane: "box"` and the
 *    connection it was verified for (`dataSourceId`). No connector code runs.
 * 2. The batch (this file). A run takes one flow's pending box-lane events,
 *    for the flow's current connection only, capped in count and bytes, and
 *    writes them as one file. The file holds the events and nothing else:
 *    never the signing secret, never headers. `--config` is the connection's
 *    credential, as a read gets it.
 * 3. The box. The connector's handler maps events to change records, and may
 *    re-fetch rows with the connection's credential. Its answer is untrusted
 *    output: every outcome, record, entity, id and size is checked here.
 * 4. The write. Records are filtered by the flow's entity selection, stamped
 *    with `_dataSourceId`/`_syncedAt` and appended to the flow's CDC store,
 *    exactly as the inline cron does (`shapeWebhookCdcRecords`).
 *
 * Isolation between connections: box-lane events never enter the inline
 * cron's scan, every batch run is per flow (one at a time, Inngest
 * singleton), concurrency is keyed by connection and capped per workspace,
 * and one batch's command is bounded by a timeout. A slow or hostile
 * connector delays only its own flow.
 */
import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  Flow,
  SourceConnection,
  WebhookEvent,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { hasCdcDestinationAdapter } from "../../sync-cdc/adapters/registry";
import { cdcIngestService } from "../../sync-cdc/ingest";
import {
  shapeWebhookCdcRecords,
  type WebhookCdcRecord,
} from "../../inngest/functions/webhook-flow";
import {
  ConnectorOutputTooLargeError,
  failureMessage,
  type RunResult,
} from "./sync-box";
import {
  SandboxedConnector,
  isWorkspaceConnectorType,
} from "./SandboxedConnector";
import {
  connectorWebhookBatchesEnabled,
  webhookBatchLimits,
  type WebhookBatchLimits,
} from "./webhook-config";

const logger = loggers.connector();

/** The box side, as this file needs it. Tests replace it. */
export interface WebhookBatchRunner {
  declaredEntities(): Promise<string[]>;
  runWebhookBatch(
    batch: { events: Array<Record<string, unknown>> },
    options: { timeoutMs: number },
  ): Promise<RunResult>;
}

export type WebhookBatchRunnerFactory = (
  connectionId: string,
) => Promise<WebhookBatchRunner>;

/**
 * The connection's connector, built the way a read builds it: the decrypted
 * credential from the source connection manager, through the sync registry.
 */
const defaultRunner: WebhookBatchRunnerFactory = async connectionId => {
  const config =
    await sourceConnectionManager.getSourceConnection(connectionId);
  if (!config) throw new Error(`Data source not found: ${connectionId}`);
  const connector = await syncConnectorRegistry.getConnectorFor(config);
  if (!(connector instanceof SandboxedConnector)) {
    throw new Error(`Connection ${connectionId} is not a workspace connector`);
  }
  return connector;
};

/** Codes a box-lane event can end with, besides the inline cron's own. */
export const BOX_CODES = {
  boxFailed: "BOX_BATCH_FAILED",
  noOutcome: "NO_OUTCOME",
  eventTooLarge: "EVENT_TOO_LARGE",
  outputTooLarge: "OUTPUT_TOO_LARGE",
  tooManyRecords: "TOO_MANY_RECORDS",
  skipped: "SKIPPED_BY_CONNECTOR",
  connectionChanged: "CONNECTION_CHANGED",
  secretInBatch: "SECRET_IN_BATCH",
} as const;

/** The longest id, change id or reason kept from a box. */
const MAX_ID_LENGTH = 512;
const MAX_REASON_LENGTH = 500;
/** Connector log lines kept per batch. */
const MAX_LOG_LINES = 50;
/** Attempts after which the retry cron leaves a failed event alone. */
const FINAL_ATTEMPTS = 5;

type StoredEvent = {
  _id: Types.ObjectId;
  eventId: string;
  eventType: string;
  rawPayload: unknown;
  receivedAt: Date;
};

export interface BatchResult {
  /** `empty`: nothing pending. `more`: take another batch. `stop`: end the run. */
  next: "empty" | "more" | "stop";
  claimed: number;
  ingested: number;
  failed: number;
  dropped: number;
  applied: number;
  /** Entities that got CDC events, to materialize now. */
  entities?: string[];
  reason?: string;
}

const emptyResult = (
  next: BatchResult["next"],
  reason?: string,
): BatchResult => ({
  next,
  claimed: 0,
  ingested: 0,
  failed: 0,
  dropped: 0,
  applied: 0,
  ...(reason ? { reason } : {}),
});

/** Flows with pending box-lane events, for the CDC scheduler's dispatch. */
export async function flowsWithPendingBoxWebhooks(
  limit = 500,
): Promise<
  Array<{ flowId: string; workspaceId: string; connectionId: string }>
> {
  const rows = (await WebhookEvent.aggregate([
    { $match: { status: "pending", lane: "box" } },
    {
      $group: {
        _id: "$flowId",
        workspaceId: { $first: "$workspaceId" },
        dataSourceId: { $first: "$dataSourceId" },
      },
    },
    { $limit: limit },
  ])) as Array<{
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    dataSourceId?: Types.ObjectId;
  }>;
  return rows.map(row => ({
    flowId: String(row._id),
    workspaceId: String(row.workspaceId),
    connectionId: String(row.dataSourceId ?? row._id),
  }));
}

/** Pending box-lane events of a flow, ended with a reason (no box ran). */
async function endPending(
  filter: Record<string, unknown>,
  status: "completed" | "failed",
  applyStatus: "dropped" | "failed",
  code: string,
  message: string,
): Promise<number> {
  const result = await WebhookEvent.updateMany(
    { ...filter, lane: "box", status: "pending" },
    {
      $set: {
        status,
        applyStatus,
        processedAt: new Date(),
        applyError: { code, message },
      },
    },
  );
  return result.modifiedCount ?? 0;
}

/** Events of one batch, cut at the count and byte caps, oldest first. */
export function cutBatch(
  events: StoredEvent[],
  limits: Pick<WebhookBatchLimits, "maxEvents" | "maxBytes">,
): { batch: StoredEvent[]; tooLarge: StoredEvent | null } {
  const batch: StoredEvent[] = [];
  // `{"events":[` + `]}` and one comma per event.
  let bytes = 13;
  for (const event of events.slice(0, limits.maxEvents)) {
    const size = Buffer.byteLength(JSON.stringify(wireEvent(event))) + 1;
    if (bytes + size > limits.maxBytes) {
      // An event that alone is over the cap can never be sent: it is
      // failed on its own, never left at the head of the queue.
      return { batch, tooLarge: batch.length === 0 ? event : null };
    }
    bytes += size;
    batch.push(event);
  }
  return { batch, tooLarge: null };
}

/** What the box sees of a stored event. */
function wireEvent(event: StoredEvent) {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    rawPayload: event.rawPayload,
    receivedAt: new Date(event.receivedAt).toISOString(),
  };
}

type CheckedOutcome =
  | { kind: "unmapped" }
  | { kind: "skipped"; reason: string }
  | { kind: "extract_failed"; reason: string }
  | { kind: "too_many"; count: number }
  | {
      kind: "records";
      records: Array<{
        entity: string;
        recordId: string;
        operation: "upsert" | "delete";
        payload: Record<string, unknown>;
        sourceTs?: Date;
        changeId?: string;
      }>;
      invalid: number;
    };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const shortString = (value: unknown, max = MAX_ID_LENGTH) =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

/** Keys only Mako writes: a connector's payload never sets them. */
function withoutSystemKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith("_mako") || key === "_syncedAt") continue;
    if (key === "_dataSourceId" || key === "_dataSourceName") continue;
    out[key] = value;
  }
  return out;
}

/**
 * One WEBHOOK message, checked. Nothing from the box is trusted: an entity
 * the connector never declared, a malformed id or payload is dropped, and a
 * count past the cap fails the event.
 */
export function checkOutcome(
  message: Record<string, unknown> | undefined,
  declared: ReadonlySet<string>,
  maxRecords: number,
): CheckedOutcome | null {
  const outcome = message?.outcome;
  if (outcome === "unmapped") return { kind: "unmapped" };
  if (outcome === "skipped") {
    return {
      kind: "skipped",
      reason:
        shortString(message?.reason, MAX_REASON_LENGTH) ??
        "The connector skipped this event",
    };
  }
  if (outcome === "extract_failed") {
    return {
      kind: "extract_failed",
      reason:
        shortString(message?.reason, MAX_REASON_LENGTH) ??
        "Failed to extract data from webhook event",
    };
  }
  if (outcome !== "records" || !Array.isArray(message?.records)) return null;
  const raw = message.records as unknown[];
  if (raw.length > maxRecords) return { kind: "too_many", count: raw.length };
  let invalid = 0;
  const records: Extract<CheckedOutcome, { kind: "records" }>["records"] = [];
  for (const item of raw) {
    const record = isPlainObject(item) ? item : {};
    const entity = shortString(record.entity, 128);
    const recordId = shortString(record.recordId);
    const operation =
      record.operation === "delete"
        ? "delete"
        : record.operation === "upsert"
          ? "upsert"
          : undefined;
    if (
      !entity ||
      !declared.has(entity) ||
      !recordId ||
      !operation ||
      !isPlainObject(record.payload)
    ) {
      invalid++;
      continue;
    }
    const ts =
      typeof record.sourceTs === "string" ? new Date(record.sourceTs) : null;
    records.push({
      entity,
      recordId,
      operation,
      payload: { ...withoutSystemKeys(record.payload), id: recordId },
      ...(ts && !Number.isNaN(ts.getTime()) ? { sourceTs: ts } : {}),
      ...(shortString(record.changeId)
        ? { changeId: record.changeId as string }
        : {}),
    });
  }
  return { kind: "records", records, invalid };
}

/**
 * One batch of one flow: claim, run in the box, check, write. Every exit
 * leaves each claimed event in a final state or failed for the retry cron;
 * none is left `processing` by this run.
 */
export async function processBoxWebhookBatch(input: {
  flowId: string;
  limits?: WebhookBatchLimits;
  runner?: WebhookBatchRunnerFactory;
}): Promise<BatchResult> {
  if (!connectorWebhookBatchesEnabled()) {
    return emptyResult("stop", "CONNECTOR_WEBHOOK_BATCHES is off");
  }
  const limits = input.limits ?? webhookBatchLimits();
  const flowId = new Types.ObjectId(input.flowId);

  const flow: any = await Flow.findById(flowId).lean();
  if (!flow) {
    await endPending(
      { flowId },
      "completed",
      "dropped",
      "FLOW_NOT_FOUND",
      `Flow ${input.flowId} no longer exists`,
    );
    return emptyResult("stop", "flow not found");
  }
  const [connection, database]: any[] = await Promise.all([
    SourceConnection.findById(flow.dataSourceId).lean(),
    DatabaseConnection.findById(flow.destinationDatabaseId).lean(),
  ]);
  if (!connection || !database) {
    await endPending(
      { flowId },
      "completed",
      "dropped",
      "MISSING_DEPENDENCY",
      `Data source or database for flow ${input.flowId} no longer exists`,
    );
    return emptyResult("stop", "missing dependency");
  }

  // Events verified for another connection never reach this one.
  await endPending(
    { flowId, dataSourceId: { $ne: connection._id } },
    "completed",
    "dropped",
    BOX_CODES.connectionChanged,
    "The flow's connection changed after this event was received",
  );

  if (!isWorkspaceConnectorType(connection.type)) {
    // The flow moved to an in-process connector: its events go back to the
    // inline cron, which handles them as it handles any other.
    await WebhookEvent.updateMany(
      { flowId, lane: "box", status: "pending" },
      { $unset: { lane: "", dataSourceId: "" } },
    );
    return emptyResult("stop", "not a workspace connector");
  }

  const isCdc =
    flow.syncEngine === "cdc" &&
    Boolean(flow.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(database.type);
  if (!isCdc) {
    await endPending(
      { flowId },
      "completed",
      "dropped",
      "NOT_CDC_FLOW",
      `Flow ${input.flowId} is not a CDC flow`,
    );
    return emptyResult("stop", "not a CDC flow");
  }

  const candidates = (await WebhookEvent.find({
    flowId,
    workspaceId: flow.workspaceId,
    dataSourceId: connection._id,
    lane: "box",
    status: "pending",
  })
    .sort({ receivedAt: 1, _id: 1 })
    .limit(limits.maxEvents)
    .select("_id eventId eventType rawPayload receivedAt")
    .lean()) as unknown as StoredEvent[];
  if (candidates.length === 0) return emptyResult("empty");

  const { batch, tooLarge } = cutBatch(candidates, limits);
  if (tooLarge) {
    await WebhookEvent.updateOne(
      { _id: tooLarge._id, status: "pending" },
      {
        $set: {
          status: "failed",
          applyStatus: "failed",
          attempts: FINAL_ATTEMPTS,
          processedAt: new Date(),
          applyError: {
            code: BOX_CODES.eventTooLarge,
            message: `The event is over the ${limits.maxBytes}-byte batch cap`,
          },
        },
      },
    );
    return { ...emptyResult("more"), failed: 1 };
  }

  const claim = randomBytes(12).toString("hex");
  await WebhookEvent.updateMany(
    { _id: { $in: batch.map(e => e._id) }, status: "pending", lane: "box" },
    { $set: { status: "processing", boxClaim: claim }, $inc: { attempts: 1 } },
  );
  const claimedIds = new Set(
    (
      await WebhookEvent.find({ boxClaim: claim, status: "processing" })
        .select("_id")
        .lean()
    ).map(e => String(e._id)),
  );
  const claimed = batch.filter(e => claimedIds.has(String(e._id)));
  if (claimed.length === 0) return emptyResult("more");

  let runner: WebhookBatchRunner;
  let declared: Set<string>;
  try {
    runner = await (input.runner ?? defaultRunner)(String(connection._id));
    declared = new Set(await runner.declaredEntities());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failClaimed(claim, claimed, reason);
    return {
      ...emptyResult("stop", reason),
      claimed: claimed.length,
      failed: claimed.length,
    };
  }
  const secret: unknown = flow.webhookConfig?.secret;

  const result = await runBatch({
    flow,
    connection,
    runner,
    declared,
    secret: typeof secret === "string" && secret.length > 0 ? secret : null,
    events: claimed,
    claim,
    limits,
  });
  await Flow.updateOne(
    { _id: flowId },
    {
      $set: {
        lastRunAt: new Date(),
        ...(result.ingested > 0 ? { lastSuccessAt: new Date() } : {}),
      },
      $inc: { runCount: 1 },
    },
  );
  logger.info("Webhook batch ran in a box", {
    flowId: input.flowId,
    claimed: claimed.length,
    ingested: result.ingested,
    applied: result.applied,
    dropped: result.dropped,
    failed: result.failed,
    reason: result.reason,
  });
  return {
    ...result,
    claimed: claimed.length,
    // A short read means the queue was drained when this batch was cut;
    // what arrived since waits for the next cron.
    next:
      result.next === "stop"
        ? "stop"
        : candidates.length < limits.maxEvents &&
            claimed.length === candidates.length
          ? "empty"
          : "more",
  };
}

/** Final status of a claimed event, written only while this run holds it. */
function settle(
  claim: string,
  event: StoredEvent,
  set: Record<string, unknown>,
  unset: Record<string, ""> = {},
) {
  return {
    updateOne: {
      filter: { _id: event._id, boxClaim: claim },
      update: {
        $set: {
          processedAt: new Date(),
          processingDurationMs:
            Date.now() - new Date(event.receivedAt).getTime(),
          ...set,
        },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    },
  };
}

const failedOp = (
  claim: string,
  event: StoredEvent,
  code: string,
  message: string,
  final = false,
) =>
  settle(claim, event, {
    status: "failed",
    applyStatus: "failed",
    applyError: { code, message: message.slice(0, MAX_REASON_LENGTH) },
    ...(final ? { attempts: FINAL_ATTEMPTS } : {}),
  });

async function runBatch(input: {
  flow: any;
  connection: any;
  runner: WebhookBatchRunner;
  declared: ReadonlySet<string>;
  secret: string | null;
  events: StoredEvent[];
  claim: string;
  limits: WebhookBatchLimits;
}): Promise<Omit<BatchResult, "claimed">> {
  const { flow, connection, runner, declared, events, claim, limits } = input;
  const totals = { ingested: 0, failed: 0, dropped: 0, applied: 0 };
  const batch = { events: events.map(wireEvent) };

  // Defense in depth: the signing secret is never part of a batch. A
  // payload that echoes it is refused rather than carried into a box.
  if (input.secret && JSON.stringify(batch).includes(input.secret)) {
    await WebhookEvent.bulkWrite(
      events.map(e =>
        failedOp(
          claim,
          e,
          BOX_CODES.secretInBatch,
          "The event holds the webhook signing secret; it is not sent to a box",
          true,
        ),
      ),
    );
    return { next: "stop", ...totals, failed: events.length };
  }

  let run: RunResult;
  try {
    run = await runner.runWebhookBatch(batch, { timeoutMs: limits.timeoutMs });
  } catch (error) {
    if (error instanceof ConnectorOutputTooLargeError) {
      if (events.length === 1) {
        await WebhookEvent.bulkWrite([
          failedOp(
            claim,
            events[0],
            BOX_CODES.outputTooLarge,
            `The connector's answer for this event is over the protocol cap (${error.message})`,
            true,
          ),
        ]);
        return { next: "more", ...totals, failed: 1 };
      }
      // Halve and run each half: the answer to a smaller batch is smaller.
      const half = Math.ceil(events.length / 2);
      const first = await runBatch({ ...input, events: events.slice(0, half) });
      if (first.next === "stop") {
        await failClaimed(claim, events.slice(half), first.reason ?? "");
        return {
          next: "stop",
          ingested: first.ingested,
          applied: first.applied,
          dropped: first.dropped,
          failed: first.failed + (events.length - half),
          entities: first.entities,
          reason: first.reason,
        };
      }
      const second = await runBatch({ ...input, events: events.slice(half) });
      return {
        next: second.next,
        ingested: first.ingested + second.ingested,
        applied: first.applied + second.applied,
        dropped: first.dropped + second.dropped,
        failed: first.failed + second.failed,
        entities: [
          ...new Set([...(first.entities ?? []), ...(second.entities ?? [])]),
        ],
        ...(second.reason ? { reason: second.reason } : {}),
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    await failClaimed(claim, events, reason);
    return { next: "stop", ...totals, failed: events.length, reason };
  }

  // The connector's own log lines, capped: a box cannot flood the API log.
  let logged = 0;
  for (const message of run.messages) {
    if (message.type !== "LOG" || logged >= MAX_LOG_LINES) continue;
    logged++;
    const log = message.log as { message?: unknown };
    if (typeof log?.message === "string") {
      logger.info("Webhook connector log", {
        flowId: String(flow._id),
        message: log.message.slice(0, 1000),
      });
    }
  }

  const failure = failureMessage(run);
  if (failure) {
    await failClaimed(claim, events, failure);
    // A timeout or a crash ends this run: the next cron tries again, and a
    // hostile connector costs at most one timeout per cron cycle.
    return { next: "stop", ...totals, failed: events.length, reason: failure };
  }

  const byEvent = new Map<string, Record<string, unknown>>();
  for (const message of run.messages) {
    if (message.type !== "WEBHOOK") continue;
    const outcome = message.webhook as Record<string, unknown> | undefined;
    const id = outcome?.eventId;
    if (outcome && typeof id === "string" && !byEvent.has(id)) {
      byEvent.set(id, outcome);
    }
  }

  const cdcEvents: Array<WebhookCdcRecord & { webhookEventId: string }> = [];
  const ops: any[] = [];
  const source = { id: String(connection._id), name: String(connection.name) };
  for (const event of events) {
    const checked = checkOutcome(
      byEvent.get(event.eventId),
      declared,
      limits.maxRecordsPerEvent,
    );
    if (!checked) {
      totals.failed++;
      ops.push(
        failedOp(
          claim,
          event,
          BOX_CODES.noOutcome,
          "The connector gave no valid outcome for this event",
        ),
      );
      continue;
    }
    if (checked.kind === "unmapped") {
      totals.applied++;
      ops.push(
        settle(
          claim,
          event,
          {
            status: "completed",
            applyStatus: "applied",
            appliedAt: new Date(),
          },
          { applyError: "" },
        ),
      );
      continue;
    }
    if (checked.kind === "skipped") {
      totals.dropped++;
      ops.push(
        settle(claim, event, {
          status: "completed",
          applyStatus: "dropped",
          applyError: { code: BOX_CODES.skipped, message: checked.reason },
        }),
      );
      continue;
    }
    if (checked.kind === "too_many") {
      totals.failed++;
      ops.push(
        failedOp(
          claim,
          event,
          BOX_CODES.tooManyRecords,
          `The connector gave ${checked.count} records for one event; the cap is ${limits.maxRecordsPerEvent}`,
          true,
        ),
      );
      continue;
    }
    if (checked.kind === "extract_failed" || checked.records.length === 0) {
      totals.failed++;
      ops.push(
        failedOp(
          claim,
          event,
          "EXTRACT_FAILED",
          checked.kind === "extract_failed"
            ? checked.reason
            : "The connector's records for this event were all invalid",
        ),
      );
      continue;
    }
    const records = shapeWebhookCdcRecords({
      rawRecords: checked.records,
      sourceConnection: source,
      flow,
      webhookEvent: { eventId: event.eventId, receivedAt: event.receivedAt },
    });
    if (records.length === 0) {
      totals.dropped++;
      ops.push(
        settle(
          claim,
          event,
          {
            status: "completed",
            applyStatus: "dropped",
            applyError: {
              code: "ENTITY_DISABLED",
              message: `No enabled entity for event ${event.eventType} in flow configuration`,
            },
          },
          { appliedAt: "" },
        ),
      );
      continue;
    }
    for (const record of records) {
      cdcEvents.push({ ...record, webhookEventId: String(event._id) });
    }
    const primary = records[0];
    ops.push({
      updateOne: {
        filter: { _id: event._id, boxClaim: claim },
        update: {
          $set: {
            status: "completed",
            processedAt: new Date(),
            entity: primary.entity,
            operation: primary.operation,
            recordId: primary.recordId,
            applyStatus: "pending",
            processingDurationMs:
              Date.now() - new Date(event.receivedAt).getTime(),
          },
          $inc: { applyAttempts: 1 },
          $unset: { applyError: "" },
        },
      },
    });
  }

  if (cdcEvents.length > 0) {
    try {
      await cdcIngestService.appendNormalizedEvents({
        workspaceId: String(flow.workspaceId),
        flowId: String(flow._id),
        events: cdcEvents,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failClaimed(claim, events, `CDC ingest failed: ${reason}`);
      return {
        next: "stop",
        ...totals,
        applied: 0,
        dropped: 0,
        ingested: 0,
        failed: events.length,
        reason,
      };
    }
    totals.ingested = cdcEvents.length;
  }
  if (ops.length > 0) await WebhookEvent.bulkWrite(ops);
  return {
    next: "more",
    ...totals,
    entities: [...new Set(cdcEvents.map(e => e.entity))],
  };
}

/** Every event still held by this claim, failed for the retry cron. */
async function failClaimed(
  claim: string,
  events: StoredEvent[],
  reason: string,
): Promise<void> {
  await WebhookEvent.updateMany(
    {
      _id: { $in: events.map(e => e._id) },
      boxClaim: claim,
      status: "processing",
    },
    {
      $set: {
        status: "failed",
        applyStatus: "failed",
        processedAt: new Date(),
        applyError: {
          code: BOX_CODES.boxFailed,
          message: reason.slice(0, MAX_REASON_LENGTH),
        },
      },
    },
  );
}
