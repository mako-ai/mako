import { inngest } from "./client";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";

export type WebhookFlowRoutingHint = {
  syncEngine?: string;
  destinationDatabaseId?: unknown;
  tableDestination?: { connectionId?: unknown };
};

export function resolveWebhookEventName(
  flow?: WebhookFlowRoutingHint,
  destinationTypeHint?: string,
): "webhook/event.process" | "webhook/event.process.cdc" {
  const isCdc =
    flow?.syncEngine === "cdc" &&
    Boolean(flow.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(destinationTypeHint);
  return isCdc ? "webhook/event.process.cdc" : "webhook/event.process";
}

export async function enqueueWebhookProcess(params: {
  flowId: string;
  workspaceId?: string;
  eventId: string;
  isReplay?: boolean;
  isTest?: boolean;
  flow?: WebhookFlowRoutingHint;
  destinationTypeHint?: string;
}): Promise<void> {
  const { flowId, workspaceId, eventId, isReplay, isTest } = params;

  await inngest.send({
    name: resolveWebhookEventName(params.flow, params.destinationTypeHint),
    data: {
      flowId,
      ...(workspaceId ? { workspaceId } : {}),
      eventId,
      ...(isReplay ? { isReplay: true } : {}),
      ...(isTest ? { isTest: true } : {}),
    },
  });
}
