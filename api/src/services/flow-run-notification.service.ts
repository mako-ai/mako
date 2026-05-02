import { Types } from "mongoose";
import {
  Connector as DataSource,
  DatabaseConnection,
  Flow,
  SavedConsole,
  NotificationRule,
  NotificationDelivery,
  SlackConnection,
  decrypt,
  encrypt,
  type IFlow,
  type INotificationRule,
  type INotificationRuleChannel,
  type INotificationRuleChannelSlack,
  type NotificationChannelType,
  type NotificationResourceType,
  type NotificationTrigger,
} from "../database/workspace-schema";
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
    const doc = await SavedConsole.findById(id).select("name").lean();
    return doc?.name || id;
  }
  const flowDoc = await Flow.findById(id);
  if (!flowDoc) return id;
  const flow = flowDoc.toObject({ getters: true }) as IFlow;
  try {
    let sourceName: string;
    let destName: string;

    if (flow.sourceType === "database" && flow.databaseSource?.connectionId) {
      const sourceDb = await DatabaseConnection.findById(
        flow.databaseSource.connectionId,
      );
      sourceName =
        sourceDb?.name || flow.databaseSource.connectionId.toString();
    } else if (flow.dataSourceId) {
      const dataSource = await DataSource.findById(flow.dataSourceId);
      sourceName = dataSource?.name || flow.dataSourceId.toString();
    } else {
      sourceName = "Unknown Source";
    }

    if (flow.tableDestination?.connectionId) {
      const destDb = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      destName = flow.tableDestination.tableName
        ? `${destDb?.name || "DB"}.${flow.tableDestination.tableName}`
        : destDb?.name || flow.tableDestination.connectionId.toString();
    } else {
      const database = await DatabaseConnection.findById(
        flow.destinationDatabaseId,
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

  const rules = await NotificationRule.find({
    workspaceId: new Types.ObjectId(event.workspaceId),
    resourceType: event.resourceType,
    resourceId: new Types.ObjectId(event.resourceId),
    enabled: true,
    triggers: trigger,
  }).lean();

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
    const ruleId = rule._id.toString();
    const channelType = rule.channel.type as NotificationChannelType;
    const idempotencyKey = buildIdempotencyKey({
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      runId: event.runId,
      trigger,
      channelType,
      ruleId,
    });

    const existing = await NotificationDelivery.findOne({ idempotencyKey }).lean();
    if (existing) {
      continue;
    }

    await NotificationDelivery.create({
      workspaceId: new Types.ObjectId(event.workspaceId),
      ruleId: new Types.ObjectId(ruleId),
      resourceType: event.resourceType,
      resourceId: new Types.ObjectId(event.resourceId),
      runId: event.runId,
      trigger,
      channelType,
      idempotencyKey,
      status: "pending",
      attempts: 0,
    });

    await inngest.send({
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
      await deliverSlack(channel, payload);
      return;
    default:
      throw new Error("Unknown channel type");
  }
}

export async function deliverNotificationJob(
  job: NotificationDeliverJobData,
): Promise<void> {
  const isTestDelivery = job.idempotencyKey.startsWith("test:");
  const rule = await NotificationRule.findById(job.ruleId).lean();
  if (!rule || !rule.enabled) {
    if (!isTestDelivery) {
      await NotificationDelivery.updateOne(
        { idempotencyKey: job.idempotencyKey },
        {
          $set: {
            status: "skipped",
            completedAt: new Date(),
            lastError: "Rule disabled or deleted",
          },
        },
      );
    }
    return;
  }

  const channel = rule.channel as INotificationRuleChannel;
  try {
    await deliverToChannel(channel, job.payload);

    if (!isTestDelivery) {
      await NotificationDelivery.updateOne(
        { idempotencyKey: job.idempotencyKey },
        {
          $set: {
            status: "sent",
            sentAt: new Date(),
            completedAt: new Date(),
          },
          $inc: { attempts: 1 },
        },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Notification delivery failed", {
      idempotencyKey: job.idempotencyKey,
      channelType: job.channelType,
      error: message,
    });
    if (!isTestDelivery) {
      await NotificationDelivery.updateOne(
        { idempotencyKey: job.idempotencyKey },
        {
          $set: {
            status: "failed",
            lastError: message,
            completedAt: new Date(),
          },
          $inc: { attempts: 1 },
        },
      );
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
  const templateData: Record<string, unknown> = {
    trigger: payload.trigger,
    resource_type: payload.resourceType,
    resource_name: payload.resourceName,
    run_id: payload.runId,
    completed_at: payload.completedAt,
    duration_ms: payload.durationMs ?? "",
    row_count: payload.rowCount ?? "",
    error_message: payload.errorMessage ?? "",
    schedule_trigger: payload.triggerType ?? "",
    open_url: payload.deepLink ?? "",
    payload_json: JSON.stringify(payload),
  };
  await emailService.sendFlowRunNotificationEmails(list, templateData);
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
    throw new Error(`Webhook HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}

function buildSlackMrkdwn(payload: NotificationOutboundPayload): string {
  return (
    `*Mako run ${payload.trigger}*\n` +
    `*${payload.resourceType}*: ${payload.resourceName}\n` +
    `Run: \`${payload.runId}\`\n` +
    `Completed: ${payload.completedAt}` +
    (payload.durationMs != null ? `\nDuration: ${payload.durationMs}ms` : "") +
    (payload.rowCount != null ? `\nRows: ${payload.rowCount}` : "") +
    (payload.errorMessage ? `\nError: ${payload.errorMessage}` : "") +
    (payload.deepLink ? `\n<${payload.deepLink}|Open in Mako>` : "")
  );
}

function buildSlackBlocks(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
  ];
}

async function deliverSlack(
  channel: INotificationRuleChannelSlack,
  payload: NotificationOutboundPayload,
): Promise<void> {
  const text = buildSlackMrkdwn(payload);
  const blocks = buildSlackBlocks(text);

  if (channel.connectionId && channel.channelId) {
    const conn = await SlackConnection.findById(channel.connectionId).lean();
    if (!conn || conn.revokedAt) {
      throw new Error("Slack connection missing or revoked");
    }
    const token = decrypt(conn.botTokenEncrypted);
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: channel.channelId,
        text,
        blocks,
      }),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
      throw new Error(
        `Slack chat.postMessage failed: ${json.error || "unknown"}`,
      );
    }
    return;
  }

  if (channel.webhookUrlEncrypted) {
    const webhookUrl = decrypt(channel.webhookUrlEncrypted);
    const slackBody = JSON.stringify({ text, blocks });
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
    return;
  }

  throw new Error("Slack channel has no connection or webhook configured");
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
  const slack = channel as INotificationRuleChannelSlack;
  if (slack.connectionId && slack.channelId) {
    return {
      type: "slack",
      connectionId: slack.connectionId,
      channelId: slack.channelId,
      channelName: slack.channelName,
      ...(slack.webhookUrlEncrypted
        ? { webhookUrlEncrypted: encrypt(slack.webhookUrlEncrypted) }
        : {}),
      displayLabel: slack.displayLabel,
    };
  }
  if (!slack.webhookUrlEncrypted) {
    throw new Error("Slack channel requires webhook URL or connection + channel");
  }
  return {
    type: "slack",
    webhookUrlEncrypted: encrypt(slack.webhookUrlEncrypted),
    displayLabel: slack.displayLabel,
  };
}

/** Strip secrets for API responses */
export function sanitizeRuleForClient(rule: INotificationRule): Record<string, unknown> {
  const base = {
    id: rule._id.toString(),
    workspaceId: rule.workspaceId.toString(),
    resourceType: rule.resourceType,
    resourceId: rule.resourceId.toString(),
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
  const slackCh = ch as INotificationRuleChannelSlack;
  return {
    ...base,
    channel: {
      type: "slack",
      displayLabel: slackCh.displayLabel || slackCh.channelName || "",
      webhookConfigured: Boolean(slackCh.webhookUrlEncrypted),
      slackConnectionId: slackCh.connectionId?.toString(),
      slackChannelId: slackCh.channelId,
      slackChannelName: slackCh.channelName,
      slackBotMode: Boolean(slackCh.connectionId && slackCh.channelId),
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
