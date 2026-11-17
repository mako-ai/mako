/**
 * A shadow's webhook updates, without a second vendor subscription.
 *
 * The live flow owns the one subscription. Ingress verifies each delivery
 * against the live flow's secret, stores it for the live flow as before,
 * and then stores a copy for each active shadow in the box lane, pinned to
 * the same connection. The shadow's twin handles the copy in its box
 * (webhook-batch.ts), as it would for a switched flow. So the live-update
 * parity window (parity.service.ts) measures webhook updates too.
 *
 * Best-effort and after the live event is saved: a failure here never
 * changes the vendor's answer or the live flow's event.
 */
import { Types } from "mongoose";
import { loggers } from "../../logging";
import { Flow, WebhookEvent } from "../../database/workspace-schema";
import { connectorWebhookBatchesEnabled } from "../workspace/webhook-config";
import {
  FLOW_RUNTIME_PROJECTION,
  boxedTwinFor,
  shadowTakesWebhooks,
  shadowsToMirror,
  type FlowRuntimeFields,
} from "./runtime";

const logger = loggers.connector();

export async function mirrorDeliveryToShadows(input: {
  flow: {
    _id: unknown;
    workspaceId: unknown;
    dataSourceId?: unknown;
    shadowOf?: unknown;
  };
  connection: { _id: unknown; type: string };
  eventId: string;
  eventType: string;
  rawPayload: unknown;
  /** Headers as stored for the live event (already redacted). */
  signature?: string;
}): Promise<number> {
  let mirrored = 0;
  try {
    const shadows = await shadowsToMirror(input.flow);
    for (const shadow of shadows) {
      if (
        !(await shadowTakesWebhooks(
          String(input.flow.workspaceId),
          input.connection.type,
          shadow,
        ))
      ) {
        continue;
      }
      try {
        await WebhookEvent.create({
          flowId: shadow._id,
          workspaceId: new Types.ObjectId(String(input.flow.workspaceId)),
          lane: "box",
          dataSourceId: new Types.ObjectId(String(input.connection._id)),
          eventId: input.eventId,
          eventType: input.eventType,
          receivedAt: new Date(),
          status: "pending",
          attempts: 0,
          rawPayload: input.rawPayload,
          ...(input.signature ? { signature: input.signature } : {}),
        });
        mirrored += 1;
      } catch (error) {
        // A vendor retry of a delivery already mirrored: the unique
        // (flowId, eventId) index holds one copy.
        if ((error as { code?: number })?.code !== 11000) throw error;
      }
    }
  } catch (error) {
    logger.warn("Mirroring a delivery to its shadows failed", {
      flowId: String(input.flow._id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return mirrored;
}

/**
 * The twin a paused built-in flow forwards its deliveries to: the flow named
 * in its `boxedSwitch` (Mongo-only, set by an owner/admin's switch) that
 * names it back in `replaces`, on the same connection. Null otherwise.
 */
export async function forwardTargetOf(flow: {
  _id: unknown;
  workspaceId: unknown;
  dataSourceId?: unknown;
  boxedSwitch?: { to?: unknown } | null;
}): Promise<FlowRuntimeFields | null> {
  if (!flow.boxedSwitch?.to) return null;
  const filter: Record<string, unknown> = {
    _id: flow.boxedSwitch.to,
    workspaceId: flow.workspaceId,
    replaces: flow._id,
    dataSourceId: flow.dataSourceId,
  };
  const target = (await Flow.findOne(filter)
    .select(FLOW_RUNTIME_PROJECTION)
    .lean()) as FlowRuntimeFields | null;
  return target;
}

/**
 * The lane a forwarded delivery takes: the box lane when the twin runs
 * boxed and webhook batches are on; else inline, where the built-in code
 * applies it (the twin runs built-in with the switch flag off).
 */
export function forwardLane(
  target: FlowRuntimeFields,
  connectionType: string,
): "box" | "inline" {
  return connectorWebhookBatchesEnabled() &&
    boxedTwinFor(target, connectionType)
    ? "box"
    : "inline";
}
