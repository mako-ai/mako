/**
 * Which code reads a built-in connection for one flow: the in-process
 * connector, or its folder twin in a box (RFC connector-runtime §10,
 * iteration 5).
 *
 * The connection does not change. A boxed run is the same connection, read
 * with the same decrypted credential, by `ws:<slug>` instead of `<slug>`: the
 * source connection the engine gets is rewritten here, and from there on a
 * boxed run is an ordinary `ws:` run (`SandboxedConnector`), with the
 * credential handed to the box exactly as for any `ws:` connection. Nothing
 * is copied into a second connection and no person handles the key.
 *
 * Two flows use this:
 * - a **shadow** (`shadowOf` set): a second flow on the live flow's
 *   connection, writing its own dataset, always boxed;
 * - a **switched** flow (`connectorRuntime: boxed`): the live flow itself.
 *
 * With CONNECTOR_BOXED_SWITCH off nothing here rewrites anything: every
 * function returns its input, and the built-in path runs as before.
 */
import { Types } from "mongoose";
import { Flow, type IFlow } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import type { SourceConnectionConfig } from "../../sync/database-data-source-manager";
import {
  loadConnectorDefinition,
  type LoadedConnector,
} from "../workspace/resolver";
import {
  SandboxedConnector,
  WORKSPACE_TYPE_PREFIX,
  isWorkspaceConnectorType,
} from "../workspace/SandboxedConnector";
import { connectorWebhookBatchesEnabled } from "../workspace/webhook-config";
import { declaredWebhookVerification } from "../workspace/webhook-verification";
import { BOXED_CAPABLE_TYPES, connectorBoxedSwitchEnabled } from "./config";
import { isTwinCodeAllowed, twinCodeRefusal } from "./twin-code";
import {
  approvalBinding,
  boxedKind,
  destinationKey,
  destinationOf,
} from "./approval";

export { approvalBinding, boxedKind, destinationKey };

export { isTwinCodeAllowed, twinCodeRefusal };

const logger = loggers.connector();

/** The flow fields this module reads. */
export type FlowRuntimeFields = Pick<
  IFlow,
  | "_id"
  | "workspaceId"
  | "dataSourceId"
  | "destinationDatabaseId"
  | "destinationDatabaseName"
  | "tableDestination"
  | "connectorRuntime"
  | "boxedConnector"
  | "shadowOf"
  | "boxedApproval"
>;

export const FLOW_RUNTIME_PROJECTION = {
  workspaceId: 1,
  dataSourceId: 1,
  destinationDatabaseId: 1,
  destinationDatabaseName: 1,
  tableDestination: 1,
  connectorRuntime: 1,
  boxedConnector: 1,
  shadowOf: 1,
  boxedApproval: 1,
} as const;

/** Whether the flow asks for its folder twin: switched, or a shadow. */
export function wantsBoxed(
  flow: Pick<IFlow, "connectorRuntime" | "shadowOf">,
): boolean {
  return boxedKind(flow) !== null;
}

/** The folder a boxed run of this flow uses: `boxedConnector`, else the type. */
export function twinSlug(
  flow: Pick<IFlow, "boxedConnector">,
  connectionType: string,
): string {
  return flow.boxedConnector?.trim() || connectionType;
}

type ApprovalFields = Pick<
  IFlow,
  | "connectorRuntime"
  | "shadowOf"
  | "boxedConnector"
  | "boxedApproval"
  | "dataSourceId"
  | "destinationDatabaseId"
  | "destinationDatabaseName"
  | "tableDestination"
>;

/**
 * Whether an owner/admin approved THIS: the kind (shadow or switch), the
 * twin, the connection, the destination tables and the live flow, as they
 * stand now. Set by flow_update or flow_shadow, never by a file; any of
 * these moved by a file edit voids it.
 */
export function isTwinApproved(flow: ApprovalFields, slug: string): boolean {
  const approval = flow.boxedApproval;
  const kind = boxedKind(flow);
  if (!approval || !kind) return false;
  const now = approvalBinding(flow);
  return (
    approval.kind === kind &&
    approval.slug === slug &&
    approval.connectionId === now.connectionId &&
    approval.destination === now.destination &&
    (approval.shadowOf ?? "") === (now.shadowOf ?? "")
  );
}

/**
 * The twin's slug when this flow, on a connection of this type, runs boxed
 * now; null when it runs as before. Null for a `ws:` connection (already
 * boxed), for a type outside the built-ins in scope, with the flag off, and
 * without a standing owner/admin approval: a `runtime: boxed` pushed in a
 * file alone changes nothing.
 */
export function boxedTwinFor(
  flow: ApprovalFields,
  connectionType: string | undefined,
): string | null {
  if (!connectorBoxedSwitchEnabled()) return null;
  if (!connectionType || isWorkspaceConnectorType(connectionType)) return null;
  if (!BOXED_CAPABLE_TYPES.has(connectionType)) return null;
  if (!wantsBoxed(flow)) return null;
  const slug = twinSlug(flow, connectionType);
  return isTwinApproved(flow, slug) ? slug : null;
}

/** The code an approval pins, from the twin's indexed definition. */
export function twinPin(
  definition: Pick<LoadedConnector, "sourceSha" | "registry">,
): { sourceSha?: string; registryHash?: string } {
  return {
    sourceSha: definition.sourceSha,
    ...(definition.registry ? { registryHash: definition.registry.hash } : {}),
  };
}

/**
 * The credential as the twin's spec asks for it: only the keys its
 * `connectionSpecification` declares, and refused when a required one is
 * missing. The refusal names keys, never values. Keys the built-in form
 * holds and the folder does not declare (Stripe's `api_base_url`) never
 * reach the box.
 */
export function configForTwin(
  config: Record<string, unknown> | undefined,
  spec: Record<string, unknown> | undefined,
  slug: string,
): Record<string, unknown> {
  const connectionSpecification = (spec as any)?.connectionSpecification as
    { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const properties = connectionSpecification?.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error(
      `The connector "${slug}" declares no connectionSpecification properties, so Mako cannot tell which credential fields it takes.`,
    );
  }
  const source = config ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = source[key];
    }
  }
  const required = Array.isArray(connectionSpecification?.required)
    ? (connectionSpecification.required as unknown[]).filter(
        (key): key is string => typeof key === "string",
      )
    : [];
  const missing = required.filter(
    key => out[key] === undefined || out[key] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `The connection lacks ${missing.join(", ")}, which the connector "${slug}" requires.`,
    );
  }
  return out;
}

/** Whether two flows write the same tables. */
export function sameDestination(
  a: FlowRuntimeFields,
  b: FlowRuntimeFields,
): boolean {
  const x = destinationOf(a);
  const y = destinationOf(b);
  return (
    x.connection === y.connection &&
    x.database === y.database &&
    x.schema === y.schema &&
    x.prefix === y.prefix
  );
}

/**
 * A shadow never writes the live dataset. Checked on every run, chunk and
 * webhook batch of a shadow, so an edited `flows/<slug>.yml` cannot point a
 * shadow at live tables: the run fails before it reads anything.
 */
export async function assertShadowIsolated(
  flow: FlowRuntimeFields,
): Promise<void> {
  if (!flow.shadowOf) return;
  const live = (await Flow.findOne({
    _id: flow.shadowOf,
    workspaceId: flow.workspaceId,
  })
    .select(FLOW_RUNTIME_PROJECTION)
    .lean()) as FlowRuntimeFields | null;
  if (!live) {
    throw new Error(
      `The shadow's live flow ${String(flow.shadowOf)} is not in this workspace.`,
    );
  }
  if (live.shadowOf) {
    throw new Error("A shadow cannot shadow another shadow.");
  }
  if (String(live.dataSourceId) !== String(flow.dataSourceId)) {
    throw new Error(
      "A shadow reads its live flow's connection; this one names another.",
    );
  }
  if (sameDestination(flow, live)) {
    throw new Error(
      "The shadow writes the live flow's dataset. A shadow must write its own (<dataset>_shadow).",
    );
  }
}

/**
 * The source connection a run of this flow uses. Unchanged unless the flow
 * runs boxed now; then `ws:<slug>`, with the same id, workspace, settings and
 * credential, trimmed to the keys the twin declares.
 */
export async function applyFlowRuntime(
  source: SourceConnectionConfig,
  flow: FlowRuntimeFields,
): Promise<SourceConnectionConfig> {
  if (flow.shadowOf && !connectorBoxedSwitchEnabled()) {
    throw new Error(
      "This is a shadow flow, and shadows run only with CONNECTOR_BOXED_SWITCH on.",
    );
  }
  const slug = boxedTwinFor(flow, source.type);
  if (!slug) {
    if (flow.shadowOf) {
      throw new Error(
        BOXED_CAPABLE_TYPES.has(source.type)
          ? "This shadow's twin has no owner/admin approval; start it with flow_shadow."
          : `A shadow runs a built-in connection's folder twin; "${source.type}" has none in scope.`,
      );
    }
    return source;
  }
  await assertShadowIsolated(flow);
  const workspaceId = source.workspaceId ?? String(flow.workspaceId);
  const definition = await loadConnectorDefinition(workspaceId, slug);
  if (!isTwinCodeAllowed(definition, flow.boxedApproval, source.type)) {
    throw new Error(twinCodeRefusal(slug));
  }
  return {
    ...source,
    workspaceId,
    type: `${WORKSPACE_TYPE_PREFIX}${slug}`,
    connection: configForTwin(source.connection, definition.spec, slug),
    // Checked again where the box loads the definition, so a push between
    // this check and the run cannot swap the code (SandboxedConnector).
    boxedPin: {
      connectionType: source.type,
      sourceSha: flow.boxedApproval?.sourceSha,
    },
  };
}

/**
 * `applyFlowRuntime` for a caller that holds only a flow id (a chunk). With
 * the flag off it returns the source without reading Mongo.
 */
export async function applyFlowRuntimeById(
  source: SourceConnectionConfig,
  flowId: string | undefined,
): Promise<SourceConnectionConfig> {
  if (!connectorBoxedSwitchEnabled() || !flowId) return source;
  if (!Types.ObjectId.isValid(flowId)) return source;
  // The flow's own workspace only: a chunk naming another workspace's flow
  // id finds nothing and runs as before.
  const flow = (await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: source.workspaceId
      ? new Types.ObjectId(String(source.workspaceId))
      : null,
  })
    .select(FLOW_RUNTIME_PROJECTION)
    .lean()) as FlowRuntimeFields | null;
  return flow ? applyFlowRuntime(source, flow) : source;
}

/** The twin's indexed definition when it can take this flow's webhooks. */
async function webhookCapableTwin(
  workspaceId: string,
  slug: string,
): Promise<LoadedConnector | null> {
  if (!connectorWebhookBatchesEnabled()) return null;
  try {
    const definition = await loadConnectorDefinition(workspaceId, slug);
    return declaredWebhookVerification(definition.spec) ? definition : null;
  } catch (error) {
    logger.warn("Folder twin unavailable for webhooks", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The connector that takes a switched flow's deliveries: its folder twin,
 * verifying in the API with the flow's secret and storing in the box lane.
 * It is built without a credential: ingress verifies, it never reads.
 *
 * Null, so ingress stays on the built-in connector, when the flow is not
 * switched, when webhook batches are off, or when the twin declares no
 * verification Mako runs. A delivery is then never refused for being
 * switched: the switch guard (switchFlowRuntime) refuses those states up
 * front, and this keeps a file edit from cutting a flow's webhooks off.
 */
export async function boxedWebhookConnector(
  flow: ApprovalFields & Pick<IFlow, "workspaceId">,
  connection: {
    _id: unknown;
    name?: string;
    type: string;
    settings?: unknown;
  },
): Promise<SandboxedConnector | null> {
  if (flow.shadowOf) return null;
  const slug = boxedTwinFor(flow, connection.type);
  if (!slug) return null;
  const workspaceId = String(flow.workspaceId);
  const twin = await webhookCapableTwin(workspaceId, slug);
  if (!twin) return null;
  if (!isTwinCodeAllowed(twin, flow.boxedApproval, connection.type)) {
    logger.warn("Switched flow's twin code changed; built-in ingress", {
      slug,
    });
    return null;
  }
  const connector = new SandboxedConnector({
    _id: connection._id,
    name: connection.name,
    type: `${WORKSPACE_TYPE_PREFIX}${slug}`,
    workspaceId,
    config: {},
    settings: connection.settings ?? {},
  } as any);
  await connector.loadDefinition();
  return connector;
}

/**
 * Shadows that get a copy of each delivery the live flow verified: active
 * (polling on), on the same connection, and with a twin that handles
 * webhooks. The copy is how a shadow sees webhook updates without a second
 * vendor subscription.
 */
export async function shadowsToMirror(flow: {
  _id: unknown;
  workspaceId: unknown;
  dataSourceId?: unknown;
  shadowOf?: unknown;
}): Promise<Array<{ _id: Types.ObjectId; slug: string }>> {
  if (!connectorBoxedSwitchEnabled() || !connectorWebhookBatchesEnabled()) {
    return [];
  }
  if (flow.shadowOf || !flow.dataSourceId) return [];
  const filter: Record<string, unknown> = {
    workspaceId: flow.workspaceId,
    shadowOf: flow._id,
    dataSourceId: flow.dataSourceId,
    "schedule.enabled": true,
    "boxedApproval.slug": { $exists: true },
    "definitionInvalid.reason": { $exists: false },
  };
  const shadows = (await Flow.find(filter)
    .select({ _id: 1, boxedConnector: 1, dataSourceId: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; boxedConnector?: string }>;
  return shadows.map(shadow => ({
    _id: shadow._id,
    slug: shadow.boxedConnector ?? "",
  }));
}

/** Whether a mirrored delivery can be handled by this shadow's twin. */
export async function shadowTakesWebhooks(
  workspaceId: string,
  connectionType: string,
  shadow: { slug: string },
): Promise<boolean> {
  if (!BOXED_CAPABLE_TYPES.has(connectionType)) return false;
  const slug = shadow.slug || connectionType;
  return Boolean(await webhookCapableTwin(workspaceId, slug));
}
