/**
 * Start and stop a boxed shadow, and switch a flow between its built-in
 * connector and its folder twin (RFC connector-runtime §10, iteration 5).
 *
 * A migration of one flow:
 * 1. `startShadow`: a second flow on the SAME connection, boxed, writing
 *    `<dataset>_shadow`, polling on the live flow's cadence and receiving a
 *    copy of the live flow's verified deliveries. Its full-history backfill
 *    starts at once.
 * 2. Parity checks (parity.service.ts), hourly and on demand.
 * 3. `switchFlowRuntime(…, "boxed")` once the gate is open: the shadow is
 *    pointed at the live dataset and takes the live triggers (poll cadence
 *    and resync cron); the built-in flow is paused (poll, webhook and resync
 *    off, crons kept for the way back), and its URL forwards each verified
 *    delivery to the twin. The vendor subscription does not change.
 * 4. `switchFlowRuntime(…, "builtin")` goes back in one call, any time.
 *
 * Every write goes through `flows/<slug>.yml` first (commitFlowFile), as the
 * flow routes do.
 */
import { Types } from "mongoose";
import {
  Flow,
  FlowExecution,
  SourceConnection,
  type IBoxedApproval,
  type IFlow,
} from "../../database/workspace-schema";
import { commitFlowFile } from "../../services/flow-config.service";
import { reserveFlowSlug } from "../../services/flow-identity.service";
import { listFlowDefinitionsAtMain } from "../../services/flow-sync.service";
import { hasWebhookTrigger } from "../../services/flow-triggers.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { moveBoxEventsToFlow } from "./relane";
import { loadConnectorDefinition } from "../workspace/resolver";
import { isWorkspaceConnectorType } from "../workspace/SandboxedConnector";
import { connectorWebhookBatchesEnabled } from "../workspace/webhook-config";
import { declaredWebhookVerification } from "../workspace/webhook-verification";
import { BOXED_CAPABLE_TYPES, connectorBoxedSwitchEnabled } from "./config";
import { parityGate, shadowOf, type ParityGate } from "./parity.service";
import {
  approvalBinding,
  assertDatasetFree,
  destinationKey,
  isTwinApproved,
  configForTwin,
  twinPin,
  twinSlug,
} from "./runtime";

/**
 * An owner/admin's approval of exactly this: the kind, the twin and the
 * code it runs (its source hash), bound to the flow's connection,
 * destination and live flow as they stand now (runtime.ts isTwinApproved).
 */
export function newApproval(
  flow: IFlow,
  kind: "shadow" | "switch",
  twin: { slug: string; pin: { sourceSha?: string; registryHash?: string } },
  userId?: string,
): IBoxedApproval {
  return {
    by: userId ?? "system",
    at: new Date(),
    kind,
    slug: twin.slug,
    ...approvalBinding(flow),
    ...twin.pin,
  };
}

/**
 * A switch changes which flow writes the live dataset. Each flow keeps its
 * own runtime and cursors, so none crosses; but two writers must never
 * race, so a switch waits until neither flow has a run in flight.
 */
async function assertNoRunInFlight(flow: IFlow): Promise<void> {
  const running = await FlowExecution.countDocuments({
    flowId: flow._id,
    status: "running",
  });
  if (running > 0 || flow.backfillState?.status === "running") {
    throw new BoxedRuntimeError(
      "A run of this flow is in flight; two flows must never write the live dataset at once. Switch when it ends (flow_status).",
    );
  }
}

type FlowDoc = InstanceType<typeof Flow>;

export class BoxedRuntimeError extends Error {}

const DEFAULT_SHADOW_POLL = "*/15 * * * *";

/** The dataset a shadow of this flow writes. */
export function shadowDataset(schema: string): string {
  return `${schema}_shadow`;
}

/**
 * What a boxed run of this flow would use, checked without running it: the
 * flag, a built-in connection in scope, an indexed twin, and a credential
 * that has every field the twin requires. Returns the twin's slug and
 * whether it handles webhooks.
 */
export async function checkTwin(flow: IFlow): Promise<{
  slug: string;
  connectionType: string;
  webhooks: boolean;
  pin: { sourceSha?: string; registryHash?: string };
}> {
  if (!connectorBoxedSwitchEnabled()) {
    throw new BoxedRuntimeError("CONNECTOR_BOXED_SWITCH is off");
  }
  if (flow.sourceType === "database" || !flow.dataSourceId) {
    throw new BoxedRuntimeError("Only connector flows can run boxed");
  }
  const connection = (await SourceConnection.findOne({
    _id: flow.dataSourceId,
    workspaceId: flow.workspaceId,
  })
    .select("type")
    .lean()) as { type?: string } | null;
  const type = connection?.type;
  if (!type) throw new BoxedRuntimeError("The flow's connection is not here");
  if (isWorkspaceConnectorType(type)) {
    throw new BoxedRuntimeError(
      `The connection is already a folder connector (${type})`,
    );
  }
  if (!BOXED_CAPABLE_TYPES.has(type)) {
    throw new BoxedRuntimeError(
      `"${type}" is not one of the built-in connectors that can run boxed (${[...BOXED_CAPABLE_TYPES].join(", ")})`,
    );
  }
  const slug = twinSlug(flow, type);
  let definition;
  try {
    definition = await loadConnectorDefinition(String(flow.workspaceId), slug);
  } catch (error) {
    throw new BoxedRuntimeError(
      `${error instanceof Error ? error.message : String(error)} For a Mako connector, commit connectors/${slug}/connector.yaml with \`source: mako/${slug}@1\`.`,
    );
  }
  const source = await sourceConnectionManager.getSourceConnection(
    String(flow.dataSourceId),
    String(flow.workspaceId),
  );
  if (!source) throw new BoxedRuntimeError("The flow's connection is not here");
  try {
    configForTwin(source.connection, definition.spec, slug);
  } catch (error) {
    throw new BoxedRuntimeError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    slug,
    connectionType: type,
    webhooks: Boolean(declaredWebhookVerification(definition.spec)),
    pin: twinPin(definition),
  };
}

export interface StartShadowResult {
  shadowFlowId: string;
  slug: string;
  dataset: string;
  created: boolean;
  backfillRunId: string | null;
  webhooksMirrored: boolean;
}

/**
 * Start (or resume) the shadow of a live flow and its full backfill.
 */
export async function startShadow(input: {
  live: FlowDoc;
  userId?: string;
  poll?: string;
  timezone?: string;
}): Promise<StartShadowResult> {
  const { live } = input;
  if (live.shadowOf) {
    throw new BoxedRuntimeError("This flow is itself a shadow");
  }
  if (live.syncEngine !== "cdc" || !live.tableDestination?.schema) {
    throw new BoxedRuntimeError(
      "A shadow needs a CDC flow with a destination dataset",
    );
  }
  const twin = await checkTwin(live);
  const webhooksMirrored =
    twin.webhooks &&
    connectorWebhookBatchesEnabled() &&
    hasWebhookTrigger(live);
  const workspaceId = String(live.workspaceId);
  const dataset = shadowDataset(live.tableDestination.schema);

  const existing = (await Flow.findOne({
    workspaceId: live.workspaceId,
    shadowOf: live._id,
  }).sort({ createdAt: -1 })) as FlowDoc | null;

  const pollCron =
    input.poll?.trim() ||
    (live.schedule?.enabled && live.schedule.cron) ||
    DEFAULT_SHADOW_POLL;
  const timezone = input.timezone?.trim() || live.schedule?.timezone || "UTC";

  // Everything that decides what the shadow reads and where it writes comes
  // from the live flow, on create and on every start: a shadow row a file
  // edited (another dataset, write mode, queries) is rebuilt, never kept.
  const table = live.tableDestination;
  const fromLive = {
    sourceType: "connector" as const,
    dataSourceId: live.dataSourceId,
    destinationDatabaseId: live.destinationDatabaseId,
    destinationDatabaseName: live.destinationDatabaseName,
    tableDestination: {
      connectionId: table.connectionId,
      database: table.database,
      schema: dataset,
      tableName: table.tableName,
      createIfNotExists: true,
      partitioning: table.partitioning,
      clustering: table.clustering,
    },
    entityFilter: live.entityFilter,
    entityLayouts: live.entityLayouts,
    queries: live.queries,
    syncMode: "incremental" as const,
    writeMode: live.writeMode,
    deleteMode: live.deleteMode,
    batchSize: live.batchSize,
    syncEngine: "cdc" as const,
    boxedConnector: live.boxedConnector,
    connectorRuntime: undefined,
    replaces: undefined,
    backfillSchedule: { enabled: false },
  };

  let shadow: FlowDoc;
  let created = false;
  if (existing) {
    shadow = existing;
    const before = shadowSettingsKey(shadow);
    shadow.set(fromLive);
    const unchanged = shadowSettingsKey(shadow) === before;
    // Already running this very twin, code and setup, and backfilling or
    // backfilled: a repeated `start` changes nothing and never restarts the
    // backfill.
    const status = shadow.backfillState?.status;
    if (
      unchanged &&
      shadow.schedule?.enabled &&
      isTwinApproved(shadow, twin.slug) &&
      shadow.boxedApproval?.sourceSha === twin.pin.sourceSha &&
      (shadow.boxedApproval?.registryHash ?? "") ===
        (twin.pin.registryHash ?? "") &&
      (status === "running" || status === "completed")
    ) {
      return {
        shadowFlowId: String(shadow._id),
        slug: shadow.slug ?? "",
        dataset: shadow.tableDestination?.schema ?? dataset,
        created: false,
        backfillRunId: shadow.backfillState?.runId ?? null,
        webhooksMirrored,
      };
    }
    // Resumed, rebuilt or a new twin: evidence starts again from a full
    // backfill.
    shadow.schedule = { enabled: true, cron: pollCron, timezone };
  } else {
    const name = `${(live.name ?? live.slug ?? "flow").slice(0, 180)} (shadow)`;
    const slug = await reserveFlowSlug(
      live.workspaceId,
      name,
      new Set((await listFlowDefinitionsAtMain(workspaceId)).map(d => d.slug)),
    );
    shadow = new Flow({
      workspaceId: live.workspaceId,
      name,
      slug,
      ...fromLive,
      schedule: { enabled: true, cron: pollCron, timezone },
      shadowOf: live._id,
      createdBy: input.userId ?? "system",
    }) as FlowDoc;
    created = true;
  }
  // No other flow may write the shadow's dataset.
  try {
    await assertDatasetFree(shadow);
  } catch (error) {
    throw new BoxedRuntimeError(
      error instanceof Error ? error.message : String(error),
    );
  }
  // The owner/admin's approval for this twin, this code, this connection
  // and this destination.
  shadow.boxedApproval = newApproval(shadow, "shadow", twin, input.userId);
  await commitAndSave(shadow, input.userId);
  const run = await cdcBackfillService.startBackfill(
    workspaceId,
    String(shadow._id),
    { trigger: "manual", reason: "boxed shadow: full-history backfill" },
  );
  return {
    shadowFlowId: String(shadow._id),
    slug: shadow.slug ?? "",
    // The dataset the shadow row actually writes.
    dataset: shadow.tableDestination?.schema ?? dataset,
    created,
    backfillRunId: run.runId,
    webhooksMirrored,
  };
}

/** What the shadow reads and writes, as one string, to tell a rebuild. */
function shadowSettingsKey(flow: IFlow): string {
  return JSON.stringify([
    destinationKey(flow),
    String(flow.dataSourceId ?? ""),
    flow.writeMode ?? "",
    flow.deleteMode ?? "",
    flow.syncMode ?? "",
    flow.boxedConnector ?? "",
    JSON.parse(JSON.stringify(flow.queries ?? [])),
    JSON.parse(JSON.stringify(flow.entityFilter ?? [])),
  ]);
}

/** Stop a shadow: polling off, copies of deliveries stop. Its data stays. */
export async function stopShadow(input: {
  live: FlowDoc;
  userId?: string;
}): Promise<{ shadowFlowId: string; cancelledBackfill: boolean } | null> {
  const shadow = (await Flow.findOne({
    workspaceId: input.live.workspaceId,
    shadowOf: input.live._id,
  }).sort({ createdAt: -1 })) as FlowDoc | null;
  if (!shadow) return null;
  shadow.schedule = {
    enabled: false,
    cron: shadow.schedule?.cron,
    timezone: shadow.schedule?.timezone,
  };
  await commitAndSave(shadow, input.userId);
  // Stop means stop: a full backfill in progress holds the key in a box
  // for hours. Cancelling it also cancels its running execution.
  let cancelledBackfill = false;
  const status = shadow.backfillState?.status;
  if (status === "running" || status === "paused") {
    await cdcBackfillService.cancelBackfill(
      String(shadow.workspaceId),
      String(shadow._id),
    );
    cancelledBackfill = true;
  }
  return { shadowFlowId: String(shadow._id), cancelledBackfill };
}

export interface SwitchResult {
  runtime: "builtin" | "boxed";
  changed: boolean;
  /** The flow writing the live dataset now. */
  writerFlowId: string;
  gate: ParityGate | null;
  forced: boolean;
  /** Forwarded events handed back to the built-in flow on a switch back. */
  relaned: number;
  /** On a switch to boxed: the twin and the exact code the approval pins. */
  approved?: { slug: string; sourceSha?: string; registryHash?: string };
}

/** The twin flow a paused built-in flow was switched to, or null. */
async function promotedTwinOf(live: IFlow): Promise<FlowDoc | null> {
  if (!live.boxedSwitch?.to) return null;
  return (await Flow.findOne({
    _id: live.boxedSwitch.to,
    workspaceId: live.workspaceId,
  })) as FlowDoc | null;
}

/**
 * Switch a built-in flow to its folder twin, or back. Name the built-in
 * (live) flow.
 *
 * Boxed: the gate must be open (or `force`). The shadow becomes the writer:
 * it points at the live dataset, takes the live poll cadence and resync
 * cron, drops `shadow_of` and gains `replaces`. The built-in flow is paused
 * (poll, webhook and resync off; their crons kept in `boxedSwitch`), and
 * its URL forwards each verified delivery to the twin.
 *
 * Built-in: one call. The twin goes back to a stopped shadow on its own
 * dataset, its forwarded events go to the built-in flow's inline lane, and
 * the built-in flow gets its triggers back.
 */
export async function switchFlowRuntime(input: {
  flow: FlowDoc;
  target: "builtin" | "boxed";
  force?: boolean;
  userId?: string;
  now?: Date;
}): Promise<SwitchResult> {
  const { flow: live, target } = input;
  if (live.shadowOf || live.replaces) {
    throw new BoxedRuntimeError("Name the built-in flow; this one is its twin");
  }

  if (target === "builtin") return switchBack(live, input);

  if (live.boxedSwitch?.to) {
    return {
      runtime: "boxed",
      changed: false,
      writerFlowId: String(live.boxedSwitch.to),
      gate: null,
      forced: false,
      relaned: 0,
    };
  }
  const shadow = (await Flow.findOne({
    workspaceId: live.workspaceId,
    shadowOf: live._id,
  }).sort({ createdAt: -1 })) as FlowDoc | null;
  if (!shadow) {
    throw new BoxedRuntimeError("No shadow: start one with flow_shadow");
  }
  const twin = await checkTwin(shadow);
  // `force` skips the parity gate only. The code that gets the key is always
  // code an owner/admin approved: the shadow's standing approval must name
  // this twin at this very code.
  const standing =
    isTwinApproved(shadow, twin.slug) &&
    (shadow.boxedApproval?.sourceSha ?? "") === (twin.pin.sourceSha ?? "") &&
    (shadow.boxedApproval?.registryHash ?? "") ===
      (twin.pin.registryHash ?? "");
  if (!standing) {
    throw new BoxedRuntimeError(
      `The shadow has no standing approval for ${twin.slug} at ${(twin.pin.registryHash ?? twin.pin.sourceSha ?? "").slice(0, 12)}. Run flow_shadow start: it approves the current code and backfills again.`,
    );
  }
  if (hasWebhookTrigger(live)) {
    if (!connectorWebhookBatchesEnabled()) {
      throw new BoxedRuntimeError(
        "The flow takes webhooks, and CONNECTOR_WEBHOOK_BATCHES is off: its deliveries would have no box lane",
      );
    }
    if (!twin.webhooks) {
      throw new BoxedRuntimeError(
        `The flow takes webhooks, and the connector "${twin.slug}" declares no webhook verification Mako runs. Turn webhooks off first, or add the declaration.`,
      );
    }
  }
  const gate = await parityGate(live, input.now, {
    slug: twin.slug,
    sourceSha: twin.pin.sourceSha,
    registryHash: twin.pin.registryHash,
  });
  if (!gate.open && !input.force) {
    throw new BoxedRuntimeError(
      `The parity gate is closed: ${gate.reasons.join("; ")}`,
    );
  }
  // Two writers must never race on the live dataset.
  await assertNoRunInFlight(live);
  await assertNoRunInFlight(shadow);

  // 1. Pause the built-in flow, keeping its crons for the way back.
  const webhookOn = hasWebhookTrigger(live);
  const pausedFrom = {
    poll: {
      enabled: Boolean(live.schedule?.enabled),
      cron: live.schedule?.cron,
      timezone: live.schedule?.timezone,
    },
    resync: {
      enabled: Boolean(live.backfillSchedule?.enabled),
      cron: live.backfillSchedule?.cron,
      timezone: live.backfillSchedule?.timezone,
      entities: live.backfillSchedule?.entities,
    },
  };
  live.boxedSwitch = {
    to: shadow._id,
    by: input.userId ?? "system",
    at: new Date(),
    ...pausedFrom,
    webhook: webhookOn,
  };
  live.schedule = { ...pausedFrom.poll, enabled: false } as IFlow["schedule"];
  live.backfillSchedule = {
    ...pausedFrom.resync,
    enabled: false,
    lastRunAt: live.backfillSchedule?.lastRunAt,
  } as IFlow["backfillSchedule"];
  if (live.webhookConfig) live.webhookConfig.enabled = false;
  await commitAndSave(live, input.userId);

  // 2. Point the shadow at live, with the live triggers.
  try {
    shadow.shadowOf = undefined;
    shadow.replaces = live._id;
    shadow.connectorRuntime = "boxed";
    shadow.tableDestination = plainTable(
      live.tableDestination,
    ) as unknown as IFlow["tableDestination"];
    shadow.destinationDatabaseId = live.destinationDatabaseId;
    shadow.destinationDatabaseName = live.destinationDatabaseName;
    shadow.entityFilter = live.entityFilter;
    shadow.entityLayouts = live.entityLayouts;
    if (pausedFrom.poll.enabled && pausedFrom.poll.cron) {
      shadow.schedule = { ...pausedFrom.poll } as IFlow["schedule"];
    }
    shadow.backfillSchedule = {
      ...pausedFrom.resync,
      lastRunAt: shadow.backfillSchedule?.lastRunAt,
    } as IFlow["backfillSchedule"];
    shadow.boxedApproval = newApproval(shadow, "switch", twin, input.userId);
    await commitAndSave(shadow, input.userId);
  } catch (error) {
    // The built-in flow resumes: never leave the dataset without a writer.
    await restoreBuiltin(live, input.userId);
    throw error;
  }
  return {
    runtime: "boxed",
    changed: true,
    writerFlowId: String(shadow._id),
    gate,
    forced: !gate.open,
    relaned: 0,
    approved: {
      slug: twin.slug,
      sourceSha: shadow.boxedApproval?.sourceSha,
      registryHash: shadow.boxedApproval?.registryHash,
    },
  };
}

function plainTable(table: IFlow["tableDestination"]) {
  const raw =
    table && typeof (table as { toObject?: unknown }).toObject === "function"
      ? (
          table as unknown as { toObject: () => Record<string, unknown> }
        ).toObject()
      : (table as unknown as Record<string, unknown>);
  return { ...(raw ?? {}) };
}

async function restoreBuiltin(live: FlowDoc, userId?: string) {
  const paused = live.boxedSwitch;
  if (!paused) return;
  live.schedule = {
    enabled: Boolean(paused.poll?.enabled),
    cron: paused.poll?.cron,
    timezone: paused.poll?.timezone,
  } as IFlow["schedule"];
  live.backfillSchedule = {
    enabled: Boolean(paused.resync?.enabled),
    cron: paused.resync?.cron,
    timezone: paused.resync?.timezone,
    entities: paused.resync?.entities,
    lastRunAt: live.backfillSchedule?.lastRunAt,
  } as IFlow["backfillSchedule"];
  if (live.webhookConfig) live.webhookConfig.enabled = paused.webhook;
  live.boxedSwitch = undefined;
  await commitAndSave(live, userId);
}

async function switchBack(
  live: FlowDoc,
  input: { force?: boolean; userId?: string },
): Promise<SwitchResult> {
  const twin = await promotedTwinOf(live);
  if (!live.boxedSwitch?.to) {
    return {
      runtime: "builtin",
      changed: false,
      writerFlowId: String(live._id),
      gate: null,
      forced: false,
      relaned: 0,
    };
  }
  let relaned = 0;
  if (twin) {
    // `force` switches back even mid-run: the way out stays one call. The
    // twin's run stops at its next chunk (applyFlowRuntimeById).
    if (!input.force) await assertNoRunInFlight(twin);
    // The twin goes back to a stopped shadow on its own dataset. A new
    // `flow_shadow start` re-approves it and backfills from scratch.
    twin.replaces = undefined;
    twin.shadowOf = live._id;
    twin.connectorRuntime = undefined;
    twin.boxedApproval = undefined;
    twin.tableDestination = {
      ...plainTable(live.tableDestination),
      schema: shadowDataset(live.tableDestination?.schema || "public"),
    } as unknown as IFlow["tableDestination"];
    twin.schedule = {
      enabled: false,
      cron: twin.schedule?.cron,
      timezone: twin.schedule?.timezone,
    } as IFlow["schedule"];
    twin.backfillSchedule = {
      enabled: false,
      cron: twin.backfillSchedule?.cron,
      timezone: twin.backfillSchedule?.timezone,
    } as IFlow["backfillSchedule"];
    await commitAndSave(twin, input.userId);
    if (live.dataSourceId) {
      relaned = await moveBoxEventsToFlow(
        twin._id,
        live._id,
        new Types.ObjectId(String(live.dataSourceId)),
      );
    }
  }
  await restoreBuiltin(live, input.userId);
  return {
    runtime: "builtin",
    changed: true,
    writerFlowId: String(live._id),
    gate: null,
    forced: false,
    relaned,
  };
}

/** What flow_status shows about runtime, shadow and gate. */
export async function runtimeStatus(flow: IFlow) {
  const wants = flow.connectorRuntime === "boxed" || Boolean(flow.shadowOf);
  const type = (
    (await SourceConnection.findOne({
      _id: flow.dataSourceId,
      workspaceId: flow.workspaceId,
    })
      .select("type")
      .lean()) as { type?: string } | null
  )?.type;
  const approved = Boolean(type && isTwinApproved(flow, twinSlug(flow, type)));
  const effective =
    connectorBoxedSwitchEnabled() && wants && approved ? "boxed" : "builtin";
  const base = {
    setting: flow.connectorRuntime === "boxed" ? "boxed" : "builtin",
    effective,
    flag: connectorBoxedSwitchEnabled(),
    boxedConnector: flow.boxedConnector ?? null,
    approval: flow.boxedApproval
      ? {
          kind: flow.boxedApproval.kind,
          slug: flow.boxedApproval.slug,
          at: flow.boxedApproval.at,
          standing: approved,
        }
      : null,
    ...(wants && !approved
      ? {
          note: "boxing is asked for without a standing owner/admin approval (none, or the connection, destination, live flow or twin changed since); run flow_update runtime=boxed or flow_shadow start",
        }
      : {}),
  };
  if (flow.shadowOf) {
    return { ...base, shadowOf: String(flow.shadowOf) };
  }
  if (flow.replaces) {
    // A promoted twin: it writes the replaced flow's dataset.
    return { ...base, replaces: String(flow.replaces) };
  }
  if (flow.boxedSwitch?.to) {
    // A built-in flow paused by a switch.
    return {
      ...base,
      switchedTo: {
        id: String(flow.boxedSwitch.to),
        at: flow.boxedSwitch.at,
        by: flow.boxedSwitch.by,
        keptCrons: {
          poll: flow.boxedSwitch.poll?.cron ?? null,
          resync: flow.boxedSwitch.resync?.cron ?? null,
        },
      },
    };
  }
  const shadow = await shadowOf(flow);
  if (!shadow) return { ...base, shadow: null, gate: null };
  const gate = await parityGate(flow);
  return {
    ...base,
    shadow: {
      id: String(shadow._id),
      slug: shadow.slug,
      dataset: shadow.tableDestination?.schema,
      polling: Boolean(shadow.schedule?.enabled),
      backfill: shadow.backfillState?.status ?? "idle",
      backfillCompletedAt: shadow.backfillState?.completedAt ?? null,
    },
    gate: {
      open: gate.open,
      reasons: gate.reasons,
      lastCheckAt: gate.check?.finishedAt ?? gate.check?.startedAt ?? null,
    },
  };
}

async function commitAndSave(flow: FlowDoc, userId?: string): Promise<void> {
  const committed = await commitFlowFile(flow, userId);
  if (!committed.ok) {
    throw new BoxedRuntimeError(
      `The flow definition could not be written to the workspace repo, so nothing was saved: ${committed.error ?? "unknown error"}`,
    );
  }
  if (committed.sourceBlobSha) flow.sourceBlobSha = committed.sourceBlobSha;
  await Flow.updateOne({ _id: flow._id }, { $unset: { definitionInvalid: 1 } });
  await flow.save();
}
