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
 * 3. `switchFlowRuntime(…, "boxed")` once the gate is open: the live flow
 *    keeps its id, dataset, cursors and vendor subscription.
 * 4. `switchFlowRuntime(…, "builtin")` goes back in one call, any time.
 *
 * Every write goes through `flows/<slug>.yml` first (commitFlowFile), as the
 * flow routes do.
 */
import { Types } from "mongoose";
import {
  Flow,
  SourceConnection,
  type IFlow,
} from "../../database/workspace-schema";
import { commitFlowFile } from "../../services/flow-config.service";
import { reserveFlowSlug } from "../../services/flow-identity.service";
import { listFlowDefinitionsAtMain } from "../../services/flow-sync.service";
import { hasWebhookTrigger } from "../../services/flow-triggers.service";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { relaneBoxEventsToInline } from "./relane";
import { loadConnectorDefinition } from "../workspace/resolver";
import { isWorkspaceConnectorType } from "../workspace/SandboxedConnector";
import { connectorWebhookBatchesEnabled } from "../workspace/webhook-config";
import { declaredWebhookVerification } from "../workspace/webhook-verification";
import { BOXED_CAPABLE_TYPES, connectorBoxedSwitchEnabled } from "./config";
import { parityGate, shadowOf, type ParityGate } from "./parity.service";
import { configForTwin, twinSlug } from "./runtime";

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

  let shadow: FlowDoc;
  let created = false;
  if (existing) {
    shadow = existing;
    if (
      shadow.schedule?.enabled &&
      shadow.backfillState?.status === "running"
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
    shadow.schedule = { enabled: true, cron: pollCron, timezone };
  } else {
    const name = `${(live.name ?? live.slug ?? "flow").slice(0, 180)} (shadow)`;
    const slug = await reserveFlowSlug(
      live.workspaceId,
      name,
      new Set((await listFlowDefinitionsAtMain(workspaceId)).map(d => d.slug)),
    );
    const table = live.tableDestination;
    shadow = new Flow({
      workspaceId: live.workspaceId,
      name,
      slug,
      sourceType: "connector",
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
      schedule: { enabled: true, cron: pollCron, timezone },
      backfillSchedule: { enabled: false },
      entityFilter: live.entityFilter,
      entityLayouts: live.entityLayouts,
      queries: live.queries,
      syncMode: "incremental",
      writeMode: live.writeMode,
      deleteMode: live.deleteMode,
      batchSize: live.batchSize,
      syncEngine: "cdc",
      connectorRuntime: "boxed",
      boxedConnector: live.boxedConnector,
      shadowOf: live._id,
      createdBy: input.userId ?? "system",
    }) as FlowDoc;
    created = true;
  }
  // The owner/admin's approval for this twin to read the connection.
  shadow.boxedApproval = {
    by: input.userId ?? "system",
    at: new Date(),
    slug: twin.slug,
  };

  await commitAndSave(shadow, input.userId);
  const run = await cdcBackfillService.startBackfill(
    workspaceId,
    String(shadow._id),
    { trigger: "manual", reason: "boxed shadow: full-history backfill" },
  );
  return {
    shadowFlowId: String(shadow._id),
    slug: shadow.slug ?? "",
    dataset,
    created,
    backfillRunId: run.runId,
    webhooksMirrored,
  };
}

/** Stop a shadow: polling off, copies of deliveries stop. Its data stays. */
export async function stopShadow(input: {
  live: FlowDoc;
  userId?: string;
}): Promise<{ shadowFlowId: string } | null> {
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
  return { shadowFlowId: String(shadow._id) };
}

export interface SwitchResult {
  runtime: "builtin" | "boxed";
  changed: boolean;
  gate: ParityGate | null;
  forced: boolean;
  /** Box-lane events handed back to the built-in connector. */
  relaned: number;
}

/**
 * Switch a live flow to its folder twin, or back. Boxed needs the parity
 * gate open, unless `force`. Built-in is always allowed and takes one call.
 */
export async function switchFlowRuntime(input: {
  flow: FlowDoc;
  target: "builtin" | "boxed";
  force?: boolean;
  userId?: string;
  now?: Date;
}): Promise<SwitchResult> {
  const { flow, target } = input;
  if (flow.shadowOf) {
    throw new BoxedRuntimeError(
      "A shadow is always boxed; switch its live flow instead",
    );
  }
  const current = flow.connectorRuntime === "boxed" ? "boxed" : "builtin";

  if (target === "builtin") {
    if (current !== "builtin" || flow.boxedApproval) {
      flow.connectorRuntime = undefined;
      // Boxing again needs a fresh owner/admin approval.
      flow.boxedApproval = undefined;
      await commitAndSave(flow, input.userId);
    }
    const relaned = flow.dataSourceId
      ? await relaneBoxEventsToInline(
          flow._id,
          new Types.ObjectId(String(flow.dataSourceId)),
        )
      : 0;
    return {
      runtime: "builtin",
      changed: current !== "builtin",
      gate: null,
      forced: false,
      relaned,
    };
  }

  const twin = await checkTwin(flow);
  if (hasWebhookTrigger(flow)) {
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
  const gate = await parityGate(flow, input.now);
  if (!gate.open && !input.force) {
    throw new BoxedRuntimeError(
      `The parity gate is closed: ${gate.reasons.join("; ")}`,
    );
  }
  const approved = flow.boxedApproval?.slug === twin.slug;
  if (current !== "boxed" || !approved) {
    flow.connectorRuntime = "boxed";
    flow.boxedApproval = {
      by: input.userId ?? "system",
      at: new Date(),
      slug: twin.slug,
    };
    await commitAndSave(flow, input.userId);
  }
  return {
    runtime: "boxed",
    changed: current !== "boxed" || !approved,
    gate,
    forced: !gate.open,
    relaned: 0,
  };
}

/** What flow_status shows about runtime, shadow and gate. */
export async function runtimeStatus(flow: IFlow) {
  const wants = flow.connectorRuntime === "boxed" || Boolean(flow.shadowOf);
  const approved = Boolean(flow.boxedApproval?.slug);
  const effective =
    connectorBoxedSwitchEnabled() && wants && approved ? "boxed" : "builtin";
  const base = {
    setting: flow.connectorRuntime === "boxed" ? "boxed" : "builtin",
    effective,
    flag: connectorBoxedSwitchEnabled(),
    boxedConnector: flow.boxedConnector ?? null,
    approval: flow.boxedApproval
      ? { slug: flow.boxedApproval.slug, at: flow.boxedApproval.at }
      : null,
    ...(wants && !approved
      ? {
          note: "runtime: boxed is in the flow file without an owner/admin approval; run flow_update runtime=boxed to approve it",
        }
      : {}),
  };
  if (flow.shadowOf) {
    return { ...base, shadowOf: String(flow.shadowOf) };
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
