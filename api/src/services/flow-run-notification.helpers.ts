import * as crypto from "crypto";
import type {
  NotificationChannelType,
  NotificationResourceType,
  NotificationTrigger,
} from "../database/workspace-schema";
import type { FlowRunTerminalEventData } from "./flow-run-notification.types";

export function terminalTriggerFromRunEvent(
  event: FlowRunTerminalEventData,
): NotificationTrigger | null {
  if (event.success) return "success";
  return "failure";
}

export function hashForIdempotencySecret(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function buildIdempotencyKey(params: {
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  ruleId: string;
}): string {
  return [
    params.resourceType,
    params.resourceId,
    params.runId,
    params.trigger,
    params.channelType,
    params.ruleId,
  ].join(":");
}

export function generateWebhookSigningSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

export function signWebhookBody(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
