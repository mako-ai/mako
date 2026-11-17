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
 * cron's scan or its retry cron, every batch run is per flow (one at a time,
 * Inngest singleton), concurrency is capped in all and per workspace, the
 * box lane's retry is capped per workspace, and one batch is one box run
 * bounded by a timeout. A slow or hostile
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
import { normalizePayloadKeys } from "../../sync-cdc/normalization";
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
import { BOXED_CAPABLE_TYPES } from "../boxed-runtime/config";
import { relaneBoxEventsToInline } from "../boxed-runtime/relane";
import {
  applyFlowRuntime,
  boxedTwinFor,
  type FlowRuntimeFields,
} from "../boxed-runtime/runtime";
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
  workspaceId: string,
  /** The flow the batch is for: a boxed built-in flow reads through its twin. */
  flow?: FlowRuntimeFields,
) => Promise<WebhookBatchRunner>;

/**
 * The connection's connector, built the way a read builds it: the decrypted
 * credential from the source connection manager, through the sync registry.
 * A built-in connection's flow that runs boxed (a shadow, or switched) gets
 * its folder twin, with the same credential (connectors/boxed-runtime).
 */
const defaultRunner: WebhookBatchRunnerFactory = async (
  connectionId,
  workspaceId,
  flow,
) => {
  const stored = await sourceConnectionManager.getSourceConnection(
    connectionId,
    workspaceId,
  );
  if (!stored) throw new Error(`Data source not found: ${connectionId}`);
  const config = flow ? await applyFlowRuntime(stored, flow) : stored;
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
  /** The inline path's code for the same case (WebhookEnrichmentRetryError). */
  deferred: "ENRICH_DEFERRED",
  connectionChanged: "CONNECTION_CHANGED",
  secretInBatch: "SECRET_IN_BATCH",
  recordTooLarge: "RECORD_TOO_LARGE",
  staleClaim: "FAILED_STALE_CLAIM",
} as const;

/** Deferrals after which an event is failed for good. */
export const MAX_DEFERRALS = 5;
/** Nesting depth a record's payload may reach (BSON allows 100). */
export const MAX_RECORD_DEPTH = 32;
/** Bytes one record's payload may serialize to. */
export const MAX_RECORD_BYTES = 1024 * 1024;
/** Records one batch may yield in all. */
export const MAX_RECORDS_PER_BATCH = 50_000;
/** A failed box-lane event waits this long before its retry. */
export const BOX_RETRY_AFTER_MS = 10 * 60_000;
/** A box-lane event claimed this long ago, still processing, was abandoned. */
export const BOX_STALE_CLAIM_MS = 15 * 60_000;

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
  deferrals?: number;
};

export interface BatchResult {
  /** `empty`: nothing pending. `more`: take another batch. `stop`: end the run. */
  next: "empty" | "more" | "stop";
  claimed: number;
  ingested: number;
  failed: number;
  dropped: number;
  applied: number;
  /** Events the connector put off (ENRICH_DEFERRED), attempt refunded. */
  deferred?: number;
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
/**
 * Flows to run now: at most one per connection, and none for a connection
 * that already holds a live claim (a batch in its box). With Inngest's
 * limits (8 in all, 3 per workspace), one connection with several flows
 * can therefore hold at most one of its workspace's 3 slots. Oldest
 * pending event first.
 *
 * A run dispatched but not yet claiming is not seen here; the singleton per
 * flow and the per-workspace limit still bound it.
 */
export async function flowsWithPendingBoxWebhooks(
  limit = 500,
  now: Date = new Date(),
): Promise<
  Array<{ flowId: string; workspaceId: string; connectionId: string }>
> {
  const busy = new Set(
    (
      (await WebhookEvent.distinct("dataSourceId", {
        status: "processing",
        lane: "box",
        claimedAt: { $gte: new Date(now.getTime() - BOX_STALE_CLAIM_MS) },
      })) as unknown[]
    ).map(String),
  );
  const rows = (await WebhookEvent.aggregate([
    { $match: { status: "pending", lane: "box" } },
    {
      $group: {
        _id: "$flowId",
        workspaceId: { $first: "$workspaceId" },
        dataSourceId: { $first: "$dataSourceId" },
        oldest: { $min: "$receivedAt" },
      },
    },
    { $sort: { oldest: 1 } },
    { $limit: limit },
  ])) as Array<{
    _id: Types.ObjectId;
    workspaceId: Types.ObjectId;
    dataSourceId?: Types.ObjectId;
  }>;
  const out: Array<{
    flowId: string;
    workspaceId: string;
    connectionId: string;
  }> = [];
  const taken = new Set<string>();
  for (const row of rows) {
    const connectionId = String(row.dataSourceId ?? row._id);
    if (busy.has(connectionId) || taken.has(connectionId)) continue;
    taken.add(connectionId);
    out.push({
      flowId: String(row._id),
      workspaceId: String(row.workspaceId),
      connectionId,
    });
  }
  return out;
}

/**
 * The box lane's own retry, run by the dispatcher every minute. The inline
 * retry cron never sees box-lane events (`lane: null`), so a box backlog
 * cannot fill its global batch, and this one is capped per workspace: at
 * most `perWorkspace` events of each of at most `workspaces` workspaces,
 * oldest first, so one workspace cannot fill it either.
 *
 * - `failed` with attempts left, settled more than BOX_RETRY_AFTER_MS ago:
 *   back to pending. A deferred event counts here too (its attempt was
 *   refunded; its deferrals are capped at MAX_DEFERRALS).
 * - `processing` claimed more than BOX_STALE_CLAIM_MS ago: the run that
 *   held it died. Back to pending.
 */
export async function retryFailedBoxWebhooks(
  options: { now?: Date; perWorkspace?: number; workspaces?: number } = {},
): Promise<{ retried: number; workspaces: number }> {
  const now = (options.now ?? new Date()).getTime();
  const perWorkspace = options.perWorkspace ?? 100;
  const groups = (await WebhookEvent.aggregate([
    {
      $match: {
        lane: "box",
        attempts: { $lt: FINAL_ATTEMPTS },
        $or: [
          {
            status: "failed",
            $or: [
              { processedAt: { $lt: new Date(now - BOX_RETRY_AFTER_MS) } },
              { processedAt: { $exists: false } },
            ],
          },
          {
            status: "processing",
            claimedAt: { $lt: new Date(now - BOX_STALE_CLAIM_MS) },
          },
        ],
      },
    },
    {
      $group: {
        _id: "$workspaceId",
        ids: {
          $topN: {
            n: perWorkspace,
            sortBy: { receivedAt: 1, _id: 1 },
            output: "$_id",
          },
        },
        oldest: { $min: "$receivedAt" },
      },
    },
    { $sort: { oldest: 1 } },
    { $limit: options.workspaces ?? 50 },
  ])) as Array<{ _id: Types.ObjectId; ids: Types.ObjectId[] }>;
  // A stale claim with no attempt left is never retried: it fails for good
  // instead of staying `processing` forever.
  await WebhookEvent.updateMany(
    {
      lane: "box",
      status: "processing",
      attempts: { $gte: FINAL_ATTEMPTS },
      claimedAt: { $lt: new Date(now - BOX_STALE_CLAIM_MS) },
    },
    {
      $set: {
        status: "failed",
        applyStatus: "failed",
        processedAt: new Date(now),
        applyError: {
          code: BOX_CODES.staleClaim,
          message: "The run holding this event died, and no attempt is left",
        },
      },
      $unset: { boxClaim: "" },
    },
  );
  const ids = groups.flatMap(group => group.ids);
  if (ids.length === 0) return { retried: 0, workspaces: 0 };
  await WebhookEvent.updateMany(
    {
      _id: { $in: ids },
      lane: "box",
      status: { $in: ["failed", "processing"] },
    },
    {
      $set: { status: "pending" },
      $unset: { applyError: "", processedAt: "", boxClaim: "", claimedAt: "" },
    },
  );
  return { retried: ids.length, workspaces: groups.length };
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
  | { kind: "deferred"; reason: string }
  | { kind: "extract_failed"; reason: string }
  | { kind: "too_many"; count: number }
  | { kind: "too_large"; reason: string }
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

const SYSTEM_KEYS = new Set(["_syncedat", "_datasourceid", "_datasourcename"]);

/**
 * Keys only Mako writes: a connector's payload never sets them. Checked on
 * the keys as the writer will see them (dots become underscores, as
 * `normalizePayloadKeys` does) and in any case, so `.mako_x`, `_MAKO_X` and
 * `_DataSourceId` are caught too.
 */
export function withoutSystemKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalizePayloadKeys(payload))) {
    const lower = key.toLowerCase();
    if (lower.startsWith("_mako") || SYSTEM_KEYS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/** Whether `value` nests deeper than `max` objects or arrays. */
function deeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (!current || typeof current !== "object") continue;
    if (depth > max) return true;
    for (const child of Object.values(current as object)) {
      if (child && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return false;
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
  if (outcome === "deferred") {
    return {
      kind: "deferred",
      reason:
        shortString(message?.reason, MAX_REASON_LENGTH) ??
        "The connector deferred this event",
    };
  }
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
    // A payload the writer cannot store (BSON caps nesting at 100) or that
    // dwarfs any real row fails its own event, never the batch.
    if (deeperThan(record.payload, MAX_RECORD_DEPTH)) {
      return {
        kind: "too_large",
        reason: `A record of ${entity} nests deeper than ${MAX_RECORD_DEPTH} levels`,
      };
    }
    if (Buffer.byteLength(JSON.stringify(record.payload)) > MAX_RECORD_BYTES) {
      return {
        kind: "too_large",
        reason: `A record of ${entity} is over ${MAX_RECORD_BYTES} bytes`,
      };
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
    // Scoped to the flow's workspace (flow-connection-scope.ts).
    SourceConnection.findOne({
      _id: flow.dataSourceId,
      workspaceId: flow.workspaceId,
    }).lean(),
    DatabaseConnection.findOne({
      _id: flow.destinationDatabaseId,
      workspaceId: flow.workspaceId,
    }).lean(),
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

  // A built-in connection's flow that runs its folder twin (a shadow, or
  // `runtime: boxed`) is boxed here too (connectors/boxed-runtime).
  const boxedTwin = boxedTwinFor(flow, connection.type);
  if (
    !boxedTwin &&
    !isWorkspaceConnectorType(connection.type) &&
    !flow.shadowOf &&
    BOXED_CAPABLE_TYPES.has(connection.type)
  ) {
    // The flow was switched back to its built-in connector (or the switch
    // flag went off). Its pending box-lane events were verified for this
    // flow and this connection: they go to the inline lane, where the
    // built-in connector applies them, instead of being dropped.
    const relaned = await relaneBoxEventsToInline(
      flowId,
      connection._id as Types.ObjectId,
    );
    await endPending(
      { flowId },
      "completed",
      "dropped",
      BOX_CODES.connectionChanged,
      "The flow's connection changed after this event was received",
    );
    return emptyResult("stop", `runtime is builtin; ${relaned} to inline`);
  }
  if (!boxedTwin && !isWorkspaceConnectorType(connection.type)) {
    // The flow moved to an in-process connector. Its box-lane events were
    // verified for, and pinned to, a workspace connection: they are dropped,
    // never handed to another connection. The new connector's own webhook
    // and its next sync carry on from here.
    await endPending(
      { flowId },
      "completed",
      "dropped",
      BOX_CODES.connectionChanged,
      "The flow's connection is no longer a workspace connector",
    );
    return emptyResult("stop", "not a workspace connector");
  }

  // Events verified for another connection never reach this one's box.
  await endPending(
    { flowId, dataSourceId: { $ne: connection._id } },
    "completed",
    "dropped",
    BOX_CODES.connectionChanged,
    "The flow's connection changed after this event was received",
  );

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

  // The flow's current batch size: halved after a failed box run, doubled
  // back after a good one (see `runBatch`).
  const stored = Number(flow.webhookConfig?.boxBatchSize);
  const size =
    Number.isSafeInteger(stored) && stored >= 1
      ? Math.min(stored, limits.maxEvents)
      : limits.maxEvents;

  const candidates = (await WebhookEvent.find({
    flowId,
    workspaceId: flow.workspaceId,
    dataSourceId: connection._id,
    lane: "box",
    status: "pending",
  })
    .sort({ receivedAt: 1, _id: 1 })
    .limit(size)
    .select("_id eventId eventType rawPayload receivedAt deferrals")
    .lean()) as unknown as StoredEvent[];
  if (candidates.length === 0) return emptyResult("empty");

  const { batch, tooLarge } = cutBatch(candidates, {
    maxEvents: size,
    maxBytes: limits.maxBytes,
  });
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
    {
      $set: { status: "processing", boxClaim: claim, claimedAt: new Date() },
      $inc: { attempts: 1 },
    },
  );
  const claimedIds = new Set(
    (
      await WebhookEvent.find({
        _id: { $in: batch.map(e => e._id) },
        boxClaim: claim,
        status: "processing",
      })
        .select("_id")
        .lean()
    ).map(e => String(e._id)),
  );
  const claimed = batch.filter(e => claimedIds.has(String(e._id)));
  if (claimed.length === 0) return emptyResult("more");

  let runner: WebhookBatchRunner;
  let declared: Set<string>;
  try {
    runner = await (input.runner ?? defaultRunner)(
      String(connection._id),
      String(flow.workspaceId),
      flow,
    );
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
  // A shadow's events are copies of its live flow's deliveries: the
  // secret kept out of the batch is the live flow's.
  const secret: unknown = flow.shadowOf
    ? (
        (await Flow.findOne({
          _id: flow.shadowOf,
          workspaceId: flow.workspaceId,
        })
          .select("webhookConfig.secret")
          .lean()) as { webhookConfig?: { secret?: unknown } } | null
      )?.webhookConfig?.secret
    : flow.webhookConfig?.secret;

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
  // A batch that failed in its box is cut in half next time; a good one
  // grows back. One bad event ends up alone, and only it fails.
  const nextSize = result.shrink
    ? Math.max(1, Math.ceil(claimed.length / 2))
    : size < limits.maxEvents
      ? Math.min(limits.maxEvents, size * 2)
      : null;
  await Flow.updateOne(
    { _id: flowId },
    {
      $set: {
        lastRunAt: new Date(),
        ...(result.ingested > 0 ? { lastSuccessAt: new Date() } : {}),
        ...(nextSize !== null
          ? { "webhookConfig.boxBatchSize": nextSize }
          : {}),
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
  const { shrink: _shrink, ...rest } = result;
  return {
    ...rest,
    claimed: claimed.length,
    // A short read means the queue was drained when this batch was cut;
    // what arrived since waits for the next cron.
    next:
      result.next === "stop"
        ? "stop"
        : candidates.length < size && claimed.length === candidates.length
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
}): Promise<Omit<BatchResult, "claimed"> & { shrink?: boolean }> {
  const { flow, connection, runner, declared, claim, limits } = input;
  const totals = {
    ingested: 0,
    failed: 0,
    dropped: 0,
    applied: 0,
    deferred: 0,
  };

  // Defense in depth: the signing secret is never part of a batch. An
  // event whose payload echoes it is failed on its own and never carried
  // into a box; the rest of the batch goes on.
  let events = input.events;
  if (input.secret) {
    const variants = secretVariants(input.secret);
    const leaking = events.filter(e => {
      const text = JSON.stringify(wireEvent(e)).toLowerCase();
      return variants.some(v => text.includes(v));
    });
    if (leaking.length > 0) {
      await WebhookEvent.bulkWrite(
        leaking.map(e =>
          failedOp(
            claim,
            e,
            BOX_CODES.secretInBatch,
            "The event holds the webhook signing secret; it is not sent to a box",
            true,
          ),
        ),
      );
      totals.failed += leaking.length;
      events = events.filter(e => !leaking.includes(e));
      if (events.length === 0) return { next: "more", ...totals };
    }
  }
  const batch = { events: events.map(wireEvent) };

  // One box run per batch, never more: a failure ends the run. With more
  // than one event, nobody knows which event caused it, so none is blamed:
  // they go back to pending with their attempt refunded, and the next batch
  // of this flow is half as large. A single event that fails is its own.
  const boxFailed = async (
    reason: string,
    final: { code: string } | null,
  ): Promise<Omit<BatchResult, "claimed"> & { shrink?: boolean }> => {
    if (events.length > 1) {
      await releaseClaimed(claim, events);
      return { next: "stop", ...totals, shrink: true, reason };
    }
    if (final) {
      await WebhookEvent.bulkWrite([
        failedOp(claim, events[0], final.code, reason, true),
      ]);
    } else {
      await failClaimed(claim, events, reason);
    }
    return { next: "stop", ...totals, failed: totals.failed + 1, reason };
  };

  let run: RunResult;
  try {
    run = await runner.runWebhookBatch(batch, { timeoutMs: limits.timeoutMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ConnectorOutputTooLargeError) {
      return boxFailed(
        `The connector's answer is over the protocol cap (${reason})`,
        { code: BOX_CODES.outputTooLarge },
      );
    }
    return boxFailed(reason, null);
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
  // A timeout or a crash ends this run: a hostile connector costs at most
  // one box run, one timeout, per dispatch.
  if (failure) return boxFailed(failure, null);

  const byEvent = new Map<string, Record<string, unknown>>();
  let totalRecords = 0;
  for (const message of run.messages) {
    if (message.type !== "WEBHOOK") continue;
    const outcome = message.webhook as Record<string, unknown> | undefined;
    const id = outcome?.eventId;
    if (outcome && typeof id === "string" && !byEvent.has(id)) {
      byEvent.set(id, outcome);
      if (Array.isArray(outcome.records)) {
        totalRecords += outcome.records.length;
      }
    }
  }
  // A cap on the whole answer, on top of the cap per event: past it, the
  // batch is treated as a failed box run (halved, nobody blamed).
  if (totalRecords > MAX_RECORDS_PER_BATCH) {
    return boxFailed(
      `The connector gave ${totalRecords} records for one batch; the cap is ${MAX_RECORDS_PER_BATCH}`,
      { code: BOX_CODES.tooManyRecords },
    );
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
    if (checked.kind === "deferred") {
      // As the inline path's ENRICH_DEFERRED: parked as `failed` with the
      // attempt refunded, so the retry cron re-queues it without using up
      // its retries, and it stays out of the pending queue meanwhile.
      // Deferrals are capped: past MAX_DEFERRALS the event is failed for
      // good, so a connector cannot keep one in the retry queue forever.
      if ((event.deferrals ?? 0) + 1 >= MAX_DEFERRALS) {
        totals.failed++;
        ops.push(
          failedOp(
            claim,
            event,
            BOX_CODES.deferred,
            `Deferred ${MAX_DEFERRALS} times: ${checked.reason}`,
            true,
          ),
        );
        continue;
      }
      totals.deferred++;
      ops.push({
        updateOne: {
          filter: { _id: event._id, boxClaim: claim },
          update: {
            $set: {
              status: "failed",
              processedAt: new Date(),
              applyError: {
                code: BOX_CODES.deferred,
                message: checked.reason,
              },
            },
            $inc: { attempts: -1, deferrals: 1 },
          },
        },
      });
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
    if (checked.kind === "too_large") {
      totals.failed++;
      ops.push(
        failedOp(claim, event, BOX_CODES.recordTooLarge, checked.reason, true),
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
    // Checked again after shaping: it may rename an entity (a generic
    // `activities` record becomes `activities:<_type>`), and a box must
    // never reach a table its connector did not declare.
    const records = shapeWebhookCdcRecords({
      rawRecords: checked.records,
      sourceConnection: source,
      flow,
      webhookEvent: { eventId: event.eventId, receivedAt: event.receivedAt },
    }).filter(record => declared.has(record.entity));
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
      // As a failed box run: with more than one event none is blamed, the
      // batch is released and the next one is half as large. Nothing of
      // this batch was settled yet, so every event is still claimed.
      const reason = error instanceof Error ? error.message : String(error);
      Object.assign(totals, {
        ingested: 0,
        failed: 0,
        dropped: 0,
        applied: 0,
        deferred: 0,
      });
      return boxFailed(`CDC ingest failed: ${reason}`, null);
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

/**
 * The forms a signing secret could take in a payload, lowercased: as is,
 * and its UTF-8 bytes (and, for a hex secret, its decoded bytes) in hex and
 * base64. A batch is compared lowercased against each.
 */
export function secretVariants(secret: string): string[] {
  const forms = new Set<string>([secret]);
  const encode = (bytes: Buffer) => {
    if (bytes.length === 0) return;
    forms.add(bytes.toString("hex"));
    forms.add(bytes.toString("base64"));
    forms.add(bytes.toString("base64").replace(/=+$/, ""));
    forms.add(bytes.toString("base64url"));
  };
  encode(Buffer.from(secret, "utf8"));
  if (/^(?:[0-9a-fA-F]{2})+$/.test(secret)) encode(Buffer.from(secret, "hex"));
  return [...forms]
    .filter(form => form.length >= 8)
    .map(form => form.toLowerCase());
}

/**
 * Events of a batch that failed as a whole, back to pending with their
 * attempt refunded: the batch failed, not they.
 */
async function releaseClaimed(
  claim: string,
  events: StoredEvent[],
): Promise<void> {
  await WebhookEvent.updateMany(
    {
      _id: { $in: events.map(e => e._id) },
      boxClaim: claim,
      status: "processing",
    },
    {
      $set: { status: "pending" },
      $inc: { attempts: -1 },
      $unset: { boxClaim: "" },
    },
  );
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
