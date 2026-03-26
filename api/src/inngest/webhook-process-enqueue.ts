import { Types } from "mongoose";
import { Flow, DatabaseConnection } from "../database/workspace-schema";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import { inngest } from "./client";

export const WEBHOOK_PROCESS_EVENT = "webhook/event.process" as const;
export const WEBHOOK_PROCESS_CDC_EVENT = "webhook/event.process.cdc" as const;

/** Minimal flow fields used to route CDC vs SQL webhook processing (must match processor logic). */
export type WebhookFlowRoutingHint = {
  syncEngine?: string;
  destinationDatabaseId?: Types.ObjectId | string | null;
  tableDestination?: { connectionId?: unknown } | null;
};

export function isCdcIngestWebhookFlow(
  flow: WebhookFlowRoutingHint,
  destinationType: string | undefined,
): boolean {
  return (
    flow.syncEngine === "cdc" &&
    Boolean(flow.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(destinationType)
  );
}

export async function resolveWebhookProcessEventName(params: {
  flowId: string;
  flow?: WebhookFlowRoutingHint | null;
  /** When enqueueing many events for the same flow, pass this to skip a DB round-trip. */
  destinationTypeHint?: string;
}): Promise<typeof WEBHOOK_PROCESS_EVENT | typeof WEBHOOK_PROCESS_CDC_EVENT> {
  let flow = params.flow ?? null;
  if (!flow?.destinationDatabaseId) {
    const doc = await Flow.findById(params.flowId)
      .select("syncEngine destinationDatabaseId tableDestination")
      .lean();
    flow = doc as WebhookFlowRoutingHint | null;
  }
  if (!flow) {
    throw new Error(`Flow not found: ${params.flowId}`);
  }
  let destinationType = params.destinationTypeHint;
  if (destinationType === undefined) {
    const dbId = flow.destinationDatabaseId;
    const dbConn =
      dbId != null
        ? await DatabaseConnection.findById(dbId).select("type").lean()
        : null;
    destinationType = dbConn?.type;
  }
  return isCdcIngestWebhookFlow(flow, destinationType)
    ? WEBHOOK_PROCESS_CDC_EVENT
    : WEBHOOK_PROCESS_EVENT;
}

export async function enqueueWebhookProcess(params: {
  flowId: string;
  workspaceId?: string;
  eventId: string;
  isReplay?: boolean;
  isTest?: boolean;
  /** When set, avoids an extra Flow query when enqueueing many events for the same flow. */
  flow?: WebhookFlowRoutingHint | null;
  destinationTypeHint?: string;
}): Promise<void> {
  const name = await resolveWebhookProcessEventName({
    flowId: params.flowId,
    flow: params.flow,
    destinationTypeHint: params.destinationTypeHint,
  });
  await inngest.send({
    name,
    data: {
      flowId: params.flowId,
      ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
      eventId: params.eventId,
      ...(params.isReplay ? { isReplay: true } : {}),
      ...(params.isTest ? { isTest: true } : {}),
    },
  });
}
