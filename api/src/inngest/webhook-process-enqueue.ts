import { inngest } from "./client";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";

export type WebhookFlowRoutingHint = {
  syncEngine?: string;
  destinationDatabaseId?: unknown;
  tableDestination?: { connectionId?: unknown };
};

export async function enqueueWebhookProcess(params: {
  flowId: string;
  workspaceId?: string;
  eventId: string;
  isReplay?: boolean;
  isTest?: boolean;
  flow?: WebhookFlowRoutingHint;
  destinationTypeHint?: string;
}): Promise<void> {
  const { flowId, workspaceId, eventId, isReplay, isTest, flow } = params;

  const isCdcPath =
    flow?.syncEngine === "cdc" &&
    Boolean(flow.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(params.destinationTypeHint);

  const eventName = isCdcPath
    ? "webhook/event.process.cdc"
    : "webhook/event.process";

  await inngest.send({
    name: eventName,
    data: {
      flowId,
      ...(workspaceId ? { workspaceId } : {}),
      eventId,
      ...(isReplay ? { isReplay: true } : {}),
      ...(isTest ? { isTest: true } : {}),
    },
  });
}
