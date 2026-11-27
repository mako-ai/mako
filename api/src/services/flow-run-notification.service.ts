import {
  Flow,
  decrypt,
  encrypt,
  type IFlow,
  type INotificationRuleChannel,
  type NotificationChannelType,
  type NotificationResourceType,
  type NotificationTrigger,
} from "../database/workspace-schema";
import { connectionsRepo } from "../repositories/connections";
import { consolesChartsRepo } from "../repositories/consoles-charts";
import {
  notificationsRepo,
  type NotificationRuleRecord,
} from "../repositories/notifications";
import { RunNotificationTemplate } from "../emails/RunNotificationEmail";
import { renderEmail } from "../emails/render";
import { loggers } from "../logging";
import { emailService } from "./email.service";
import {
  buildIdempotencyKey,
  signWebhookBody,
  terminalTriggerFromRunEvent,
} from "./flow-run-notification.helpers";
import type {
  FlowRunTerminalEventData,
  NotificationDeliverJobData,
  NotificationOutboundPayload,
} from "./flow-run-notification.types";

const logger = loggers.inngest("notification");

function clientUrl(): string {
  return (
    process.env.CLIENT_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_URL?.replace(/\/$/, "") ||
    ""
  );
}

export async function resolveResourceDisplayName(params: {
  resourceType: NotificationResourceType;
  resourceId: string;
}): Promise<string> {
  const id = params.resourceId;
  if (params.resourceType === "scheduled_query") {
    const doc = await consolesChartsRepo.findConsoleByIdGlobal(id);
    return doc?.name || id;
  }
  const flowDoc = await Flow.findById(id);
  if (!flowDoc) return id;
  const flow = flowDoc.toObject({ getters: true }) as IFlow;
  try {
    let sourceName: string;
    let destName: string;

    const workspaceId = flow.workspaceId.toString();
    if (flow.sourceType === "database" && flow.databaseSource?.connectionId) {
      const sourceDb = await connectionsRepo.findDatabaseConnectionSummary(
        flow.databaseSource.connectionId.toString(),
        workspaceId,
      );
      sourceName =
        sourceDb?.name || flow.databaseSource.connectionId.toString();
    } else if (flow.dataSourceId) {
      const sourceConnection = await connectionsRepo.findSourceConnectionById(
        flow.dataSourceId.toString(),
        workspaceId,
      );
      sourceName = sourceConnection?.name || flow.dataSourceId.toString();
    } else {
      sourceName = "Unknown Source";
    }

    if (flow.tableDestination?.connectionId) {
      const destDb = await connectionsRepo.findDatabaseConnectionSummary(
        flow.tableDestination.connectionId.toString(),
        workspaceId,
      );
      destName = flow.tableDestination.tableName
        ? `${destDb?.name || "DB"}.${flow.tableDestination.tableName}`
        : destDb?.name || flow.tableDestination.connectionId.toString();
    } else {
      const database = await connectionsRepo.findDatabaseConnectionSummary(
        flow.destinationDatabaseId.toString(),
        workspaceId,
      );
      destName = database?.name || flow.destinationDatabaseId.toString();
    }

    return `${sourceName} → ${destName}`;
  } catch {
    return id;
  }
}

export function buildOutboundPayload(params: {
  event: FlowRunTerminalEventData;
  resourceName: string;
  trigger: NotificationTrigger;
}): NotificationOutboundPayload {
  const base = clientUrl();
  const deepLink =
    params.event.resourceType === "flow"
      ? base
        ? `${base}/workspace/${params.event.workspaceId}/flows/${params.event.resourceId}`
        : undefined
      : base
        ? `${base}/workspace/${params.event.workspaceId}/console/${params.event.resourceId}`
        : undefined;

  return {
    version: 1,
    event: "flow.run.terminal",
    trigger: params.trigger,
    resourceType: params.event.resourceType,
    resourceId: params.event.resourceId,
    resourceName: params.resourceName,
    runId: params.event.runId,
    completedAt: params.event.completedAt,
    durationMs: params.event.durationMs,
    rowCount: params.event.rowCount,
    errorMessage: params.event.errorMessage,
    triggerType: params.event.triggerType,
    workspaceId: params.event.workspaceId,
    deepLink,
  };
}

export async function fanOutTerminalRunNotifications(
  event: FlowRunTerminalEventData,
): Promise<{ deliveriesQueued: number }> {
  const trigger = terminalTriggerFromRunEvent(event);
  if (!trigger) {
    return { deliveriesQueued: 0 };
  }

  const rules = await notificationsRepo.listEnabledRulesForTrigger(
    event.workspaceId,
    event.resourceType,
    event.resourceId,
    trigger,
  );

  if (rules.length === 0) {
    return { deliveriesQueued: 0 };
  }

  const resourceName = await resolveResourceDisplayName({
    resourceType: event.resourceType,
    resourceId: event.resourceId,
  });
  const payload = buildOutboundPayload({ event, resourceName, trigger });

  const { inngest } = await import("../inngest/client");
  let count = 0;
  for (const rule of rules) {
    const ruleId = rule.id;
    const channelType = rule.channel.type as NotificationChannelType;
    const idempotencyKey = buildIdempotencyKey({
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      runId: event.runId,
      trigger,
      channelType,
      ruleId,
    });

    const pending = await notificationsRepo.ensurePendingDelivery({
      workspaceId: event.workspaceId,
      ruleId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      runId: event.runId,
      trigger,
      channelType,
      idempotencyKey,
    });
    if (!pending) {
      continue;
    }

    await inngest.send({
      id: idempotencyKey,
      name: "notification/deliver",
      data: {
        workspaceId: event.workspaceId,
        ruleId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        runId: event.runId,
        trigger,
        channelType,
        idempotencyKey,
        payload,
      } satisfies NotificationDeliverJobData,
    });
    count++;
  }

  return { deliveriesQueued: count };
}

async function deliverToChannel(
  channel: INotificationRuleChannel,
  payload: NotificationOutboundPayload,
): Promise<void> {
  switch (channel.type) {
    case "email":
      await deliverEmail(channel.recipients, payload);
      return;
    case "webhook":
      await deliverWebhook(
        decrypt(channel.urlEncrypted),
        decrypt(channel.signingSecretEncrypted),
        payload,
      );
      return;
    case "slack":
      await deliverSlack(decrypt(channel.webhookUrlEncrypted), payload);
      return;
    default:
      throw new Error("Unknown channel type");
  }
}

export async function deliverNotificationJob(
  job: NotificationDeliverJobData,
): Promise<void> {
  const isTestDelivery = job.idempotencyKey.startsWith("test:");
  const rule = await notificationsRepo.findRuleInWorkspace(
    job.workspaceId,
    job.ruleId,
  );
  if (!rule || !rule.enabled) {
    if (!isTestDelivery) {
      await notificationsRepo.completeDelivery(job.idempotencyKey, {
        status: "skipped",
        completedAt: new Date(),
        lastError: "Rule disabled or deleted",
        countAttempt: false,
      });
    }
    return;
  }

  const channel = rule.channel;
  try {
    await deliverToChannel(channel, job.payload);

    if (!isTestDelivery) {
      const now = new Date();
      await notificationsRepo.completeDelivery(job.idempotencyKey, {
        status: "sent",
        sentAt: now,
        completedAt: now,
        countAttempt: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Notification delivery failed", {
      idempotencyKey: job.idempotencyKey,
      channelType: job.channelType,
      error: message,
    });
    if (!isTestDelivery) {
      await notificationsRepo.completeDelivery(job.idempotencyKey, {
        status: "failed",
        lastError: message,
        completedAt: new Date(),
        countAttempt: true,
      });
    }
    throw err;
  }
}

/** Direct delivery for UI tests or unsaved rule drafts */
export async function deliverNotificationJobDirect(
  job: Omit<NotificationDeliverJobData, "ruleId"> & { ruleId?: string },
  channel: INotificationRuleChannel,
): Promise<void> {
  try {
    await deliverToChannel(channel, job.payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Direct notification delivery failed", {
      channelType: channel.type,
      error: message,
    });
    throw err;
  }
}

async function deliverEmail(
  recipients: string[],
  payload: NotificationOutboundPayload,
): Promise<void> {
  const list = recipients.map(r => r.trim()).filter(Boolean);
  if (list.length === 0) return;
  const { html, text, subject } = await renderEmail(
    RunNotificationTemplate,
    payload,
  );
  await emailService.sendFlowRunNotificationEmails(list, {
    html,
    text,
    subject,
  });
}

async function deliverWebhook(
  url: string,
  signingSecret: string,
  payload: NotificationOutboundPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const sig = signWebhookBody(signingSecret, body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mako-Signature": sig,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Webhook HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}

async function deliverSlack(
  webhookUrl: string,
  payload: NotificationOutboundPayload,
): Promise<void> {
  const text =
    `*Mako run ${payload.trigger}*\n` +
    `*${payload.resourceType}*: ${payload.resourceName}\n` +
    `Run: \`${payload.runId}\`\n` +
    `Completed: ${payload.completedAt}` +
    (payload.durationMs != null ? `\nDuration: ${payload.durationMs}ms` : "") +
    (payload.rowCount != null ? `\nRows: ${payload.rowCount}` : "") +
    (payload.errorMessage ? `\nError: ${payload.errorMessage}` : "") +
    (payload.deepLink ? `\n<${payload.deepLink}|Open in Mako>` : "");

  const slackBody = JSON.stringify({
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text,
        },
      },
    ],
  });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: slackBody,
  });
  if (!response.ok) {
    const t = await response.text().catch(() => "");
    throw new Error(
      `Slack webhook HTTP ${response.status}${t ? `: ${t.slice(0, 200)}` : ""}`,
    );
  }
}

/** Encrypt channel secrets for persistence */
export function encryptNotificationChannel(
  channel: INotificationRuleChannel,
): INotificationRuleChannel {
  if (channel.type === "email") {
    return channel;
  }
  if (channel.type === "webhook") {
    return {
      type: "webhook",
      urlEncrypted: encrypt(channel.urlEncrypted),
      signingSecretEncrypted: encrypt(channel.signingSecretEncrypted),
    };
  }
  return {
    type: "slack",
    webhookUrlEncrypted: encrypt(channel.webhookUrlEncrypted),
    displayLabel: channel.displayLabel,
  };
}

/** Strip secrets for API responses */
export function sanitizeRuleForClient(
  rule: NotificationRuleRecord,
): Record<string, unknown> {
  const base = {
    id: rule.id,
    workspaceId: rule.workspaceId,
    resourceType: rule.resourceType,
    resourceId: rule.resourceId,
    enabled: rule.enabled,
    triggers: rule.triggers,
    createdBy: rule.createdBy,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
  const ch = rule.channel;
  if (ch.type === "email") {
    return { ...base, channel: { type: "email", recipients: ch.recipients } };
  }
  if (ch.type === "webhook") {
    return {
      ...base,
      channel: {
        type: "webhook",
        urlPreview: maskUrl(decrypt(ch.urlEncrypted)),
        hasSigningSecret: Boolean(ch.signingSecretEncrypted),
      },
    };
  }
  return {
    ...base,
    channel: {
      type: "slack",
      displayLabel: ch.displayLabel || "",
      webhookConfigured: Boolean(ch.webhookUrlEncrypted),
    },
  };
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.slice(0, 24)}…`;
  } catch {
    return "••••";
  }
}
