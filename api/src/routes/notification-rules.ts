/**
 * Workspace-scoped notification rules for scheduled queries and flows.
 * Authenticated + workspace member access; admin-only for mutations.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  Flow,
  NotificationDelivery,
  NotificationRule,
  SavedConsole,
  decrypt,
  type INotificationRuleChannel,
  type NotificationChannelType,
  type NotificationResourceType,
  type NotificationTrigger,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { principalOf, workspaceAccessDenial } from "./lib/workspace-access";
import {
  buildOutboundPayload,
  deliverNotificationJobDirect,
  encryptNotificationChannel,
  resolveResourceDisplayName,
  sanitizeRuleForClient,
} from "../services/flow-run-notification.service";
import type { NotificationDeliverJobData } from "../services/flow-run-notification.types";
import {
  generateWebhookSigningSecret,
  hashForIdempotencySecret,
} from "../services/flow-run-notification.helpers";
import { inngest } from "../inngest";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { fail, failFromThrown } from "./lib/respond";

const logger = loggers.api("notification-rules");

export const notificationRulesRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const RuleIdParam = WorkspaceParam.extend({
  ruleId: z.string().openapi({ param: { name: "ruleId", in: "path" } }),
});
const ResourceQuery = z.object({
  resourceType: z
    .enum(["flow", "scheduled_query"])
    .optional()
    .openapi({
      param: { name: "resourceType", in: "query" },
    }),
  resourceId: z
    .string()
    .optional()
    .openapi({ param: { name: "resourceId", in: "query" } }),
});
const OpenBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

notificationRulesRoutes.use("*", unifiedAuthMiddleware);

notificationRulesRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId") as string;

  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return fail(c, 400, "Invalid workspace ID format");
  }

  // A session user must be a member; an API key must belong to THIS
  // workspace (its creator being a member elsewhere is not enough).
  const denial = await workspaceAccessDenial(principalOf(c), workspaceId);
  if (denial) return fail(c, denial.status, denial.error);

  await next();
});

async function assertResourceInWorkspace(
  workspaceId: string,
  resourceType: NotificationResourceType,
  resourceId: string,
): Promise<boolean> {
  const ws = new Types.ObjectId(workspaceId);
  const rid = new Types.ObjectId(resourceId);
  if (resourceType === "scheduled_query") {
    const doc = await SavedConsole.findOne({
      _id: rid,
      workspaceId: ws,
    }).lean();
    return !!doc;
  }
  const doc = await Flow.findOne({
    _id: rid,
    workspaceId: ws,
  }).lean();
  return !!doc;
}

function parseTriggers(raw: unknown): NotificationTrigger[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NotificationTrigger[] = [];
  for (const t of raw) {
    if (t === "success" || t === "failure") out.push(t);
  }
  return out.length > 0 ? [...new Set(out)] : null;
}

function parseChannelFromBody(body: Record<string, unknown>): {
  channel: INotificationRuleChannel;
  rotateWebhookSecret?: boolean;
  /** Present only when a new signing secret was generated (plain text, return once) */
  webhookSigningSecretPlain?: string;
} | null {
  const type = body.channelType as NotificationChannelType | undefined;
  if (type === "email") {
    const recipients = body.recipients;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return null;
    }
    const emails = recipients
      .filter((r): r is string => typeof r === "string")
      .map(r => r.trim())
      .filter(Boolean);
    if (emails.length === 0) return null;
    return { channel: { type: "email", recipients: emails } };
  }
  if (type === "webhook") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return null;
    const signingSecret =
      typeof body.signingSecret === "string" && body.signingSecret.trim()
        ? body.signingSecret.trim()
        : generateWebhookSigningSecret();
    const generatedNewSecret = !(
      typeof body.signingSecret === "string" && body.signingSecret.trim()
    );
    return {
      channel: {
        type: "webhook",
        urlEncrypted: url,
        signingSecretEncrypted: signingSecret,
      },
      rotateWebhookSecret: Boolean(body.rotateWebhookSecret),
      webhookSigningSecretPlain: generatedNewSecret ? signingSecret : undefined,
    };
  }
  if (type === "slack") {
    const webhookUrl =
      typeof body.slackWebhookUrl === "string"
        ? body.slackWebhookUrl.trim()
        : "";
    if (!webhookUrl) return null;
    const displayLabel =
      typeof body.displayLabel === "string" ? body.displayLabel.trim() : "";
    return {
      channel: {
        type: "slack",
        webhookUrlEncrypted: webhookUrl,
        displayLabel: displayLabel || undefined,
      },
    };
  }
  return null;
}

notificationRulesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Notification Rules"],
    summary: "List notification rules",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, query: ResourceQuery },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const resourceType = c.req.query("resourceType") as
        NotificationResourceType | undefined;
      const resourceId = c.req.query("resourceId");

      if (
        !resourceType ||
        (resourceType !== "flow" && resourceType !== "scheduled_query") ||
        !resourceId ||
        !Types.ObjectId.isValid(resourceId)
      ) {
        return fail(c, 400, "resourceType and resourceId required");
      }

      const ok = await assertResourceInWorkspace(
        workspaceId,
        resourceType,
        resourceId,
      );
      if (!ok) {
        return fail(c, 404, "Resource not found");
      }

      const rules = await NotificationRule.find({
        workspaceId: new Types.ObjectId(workspaceId),
        resourceType,
        resourceId: new Types.ObjectId(resourceId),
      }).sort({ createdAt: 1 });

      return c.json({
        success: true,
        rules: rules.map(r => sanitizeRuleForClient(r)),
      });
    } catch (error) {
      logger.error("List notification rules failed", { error });
      return failFromThrown(c, error, "Failed to list notification rules");
    }
  },
);

notificationRulesRoutes.openapi(
  createRoute({
    method: "get",
    path: "/deliveries",
    tags: ["Notification Rules"],
    summary: "List notification deliveries",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: ResourceQuery.extend({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const resourceType = c.req.query("resourceType") as
        NotificationResourceType | undefined;
      const resourceId = c.req.query("resourceId");
      const limitRaw = c.req.query("limit");
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(limitRaw || "50", 10) || 50),
      );

      if (
        !resourceType ||
        (resourceType !== "flow" && resourceType !== "scheduled_query") ||
        !resourceId ||
        !Types.ObjectId.isValid(resourceId)
      ) {
        return fail(c, 400, "resourceType and resourceId required");
      }

      const ok = await assertResourceInWorkspace(
        workspaceId,
        resourceType,
        resourceId,
      );
      if (!ok) {
        return fail(c, 404, "Resource not found");
      }

      const deliveries = await NotificationDelivery.find({
        workspaceId: new Types.ObjectId(workspaceId),
        resourceType,
        resourceId: new Types.ObjectId(resourceId),
      })
        .sort({ completedAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();

      return c.json({
        success: true,
        deliveries: deliveries.map(d => ({
          id: d._id.toString(),
          ruleId: d.ruleId.toString(),
          runId: d.runId,
          trigger: d.trigger,
          channelType: d.channelType,
          status: d.status,
          attempts: d.attempts,
          lastError: d.lastError,
          httpStatus: d.httpStatus,
          sentAt: d.sentAt,
          completedAt: d.completedAt,
          createdAt: d.createdAt,
        })),
      });
    } catch (error) {
      logger.error("List notification deliveries failed", { error });
      return failFromThrown(c, error, "Failed to list deliveries");
    }
  },
);

notificationRulesRoutes.use("*", requireWorkspaceAdmin);

notificationRulesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Notification Rules"],
    summary: "Create a notification rule",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const user = c.get("user");
      const body = (await c.req.json()) as Record<string, unknown>;

      const resourceType = body.resourceType as NotificationResourceType;
      const resourceId = body.resourceId as string;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
      const triggers = parseTriggers(body.triggers);

      if (
        !resourceType ||
        (resourceType !== "flow" && resourceType !== "scheduled_query") ||
        !resourceId ||
        !Types.ObjectId.isValid(resourceId) ||
        !triggers
      ) {
        return fail(c, 400, "Invalid resource or triggers");
      }

      const ok = await assertResourceInWorkspace(
        workspaceId,
        resourceType,
        resourceId,
      );
      if (!ok) {
        return fail(c, 404, "Resource not found");
      }

      const parsed = parseChannelFromBody(body);
      if (!parsed) {
        return fail(c, 400, "Invalid channel configuration");
      }

      const channel = encryptNotificationChannel(parsed.channel);

      const doc = await NotificationRule.create({
        workspaceId: new Types.ObjectId(workspaceId),
        resourceType,
        resourceId: new Types.ObjectId(resourceId),
        enabled,
        triggers,
        channel,
        createdBy: user?.id || "unknown",
      });

      const response: Record<string, unknown> = {
        success: true,
        rule: sanitizeRuleForClient(doc),
      };
      if (
        parsed.channel.type === "webhook" &&
        parsed.webhookSigningSecretPlain
      ) {
        response.signingSecretOnce = parsed.webhookSigningSecretPlain;
      }

      return c.json(response);
    } catch (error) {
      logger.error("Create notification rule failed", { error });
      return failFromThrown(c, error, "Failed to create notification rule");
    }
  },
);

notificationRulesRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{ruleId}",
    tags: ["Notification Rules"],
    summary: "Update a notification rule",
    security: AUTH_SECURITY,
    request: { params: RuleIdParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const ruleId = c.req.param("ruleId") as string;
      if (!Types.ObjectId.isValid(ruleId)) {
        return fail(c, 400, "Invalid rule id");
      }

      const existing = await NotificationRule.findOne({
        _id: new Types.ObjectId(ruleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!existing) {
        return fail(c, 404, "Rule not found");
      }

      const body = (await c.req.json()) as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      let signingSecretOnceOut: string | undefined;

      if (typeof body.enabled === "boolean") {
        update.enabled = body.enabled;
      }
      const triggers = parseTriggers(body.triggers);
      if (triggers) {
        update.triggers = triggers;
      }

      if (body.channelType !== undefined) {
        const channelType = body.channelType as NotificationChannelType;
        let channel: INotificationRuleChannel;

        if (channelType === "email") {
          const parsed = parseChannelFromBody(body);
          if (!parsed || parsed.channel.type !== "email") {
            return fail(c, 400, "Invalid email recipients");
          }
          channel = encryptNotificationChannel(parsed.channel);
        } else if (channelType === "webhook") {
          if (existing.channel.type !== "webhook") {
            const parsed = parseChannelFromBody(body);
            if (!parsed || parsed.channel.type !== "webhook") {
              return fail(c, 400, "Webhook URL required");
            }
            channel = encryptNotificationChannel(parsed.channel);
          } else {
            const prev = existing.channel as {
              urlEncrypted: string;
              signingSecretEncrypted: string;
            };
            const urlRaw =
              typeof body.url === "string" && body.url.trim()
                ? body.url.trim()
                : decrypt(prev.urlEncrypted);
            let secretPlain: string;
            let newSecretOnce: string | undefined;
            if (body.rotateWebhookSecret) {
              secretPlain = generateWebhookSigningSecret();
              newSecretOnce = secretPlain;
            } else if (
              typeof body.signingSecret === "string" &&
              body.signingSecret.trim()
            ) {
              secretPlain = body.signingSecret.trim();
            } else {
              secretPlain = decrypt(prev.signingSecretEncrypted);
            }
            channel = encryptNotificationChannel({
              type: "webhook",
              urlEncrypted: urlRaw,
              signingSecretEncrypted: secretPlain,
            });
            if (newSecretOnce) {
              signingSecretOnceOut = newSecretOnce;
            }
          }
        } else if (channelType === "slack") {
          if (existing.channel.type !== "slack") {
            const parsed = parseChannelFromBody(body);
            if (!parsed || parsed.channel.type !== "slack") {
              return fail(c, 400, "Slack webhook URL required");
            }
            channel = encryptNotificationChannel(parsed.channel);
          } else {
            const prev = existing.channel as {
              webhookUrlEncrypted: string;
              displayLabel?: string;
            };
            const urlRaw =
              typeof body.slackWebhookUrl === "string" &&
              body.slackWebhookUrl.trim()
                ? body.slackWebhookUrl.trim()
                : decrypt(prev.webhookUrlEncrypted);
            const displayLabel =
              typeof body.displayLabel === "string"
                ? body.displayLabel.trim()
                : prev.displayLabel;
            channel = encryptNotificationChannel({
              type: "slack",
              webhookUrlEncrypted: urlRaw,
              displayLabel: displayLabel || undefined,
            });
          }
        } else {
          return fail(c, 400, "Invalid channel type");
        }

        update.channel = channel;
      }

      if (Object.keys(update).length === 0) {
        return c.json({ success: true, rule: sanitizeRuleForClient(existing) });
      }

      Object.assign(existing, update);
      await existing.save();

      return c.json({
        success: true,
        rule: sanitizeRuleForClient(existing),
        ...(signingSecretOnceOut
          ? { signingSecretOnce: signingSecretOnceOut }
          : {}),
      });
    } catch (error) {
      logger.error("Update notification rule failed", { error });
      return failFromThrown(c, error, "Failed to update notification rule");
    }
  },
);

notificationRulesRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{ruleId}",
    tags: ["Notification Rules"],
    summary: "Delete a notification rule",
    security: AUTH_SECURITY,
    request: { params: RuleIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const ruleId = c.req.param("ruleId") as string;
      if (!Types.ObjectId.isValid(ruleId)) {
        return fail(c, 400, "Invalid rule id");
      }

      const result = await NotificationRule.deleteOne({
        _id: new Types.ObjectId(ruleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (result.deletedCount === 0) {
        return fail(c, 404, "Rule not found");
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Delete notification rule failed", { error });
      return failFromThrown(c, error, "Failed to delete notification rule");
    }
  },
);

notificationRulesRoutes.openapi(
  createRoute({
    method: "post",
    path: "/test",
    tags: ["Notification Rules"],
    summary: "Send a test notification",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const body = (await c.req.json()) as Record<string, unknown>;

      const resourceType = body.resourceType as NotificationResourceType;
      const resourceId = body.resourceId as string;
      const ruleId = typeof body.ruleId === "string" ? body.ruleId : undefined;
      const trigger = body.trigger === "success" ? "success" : "failure";

      if (
        !resourceType ||
        (resourceType !== "flow" && resourceType !== "scheduled_query") ||
        !resourceId ||
        !Types.ObjectId.isValid(resourceId)
      ) {
        return fail(c, 400, "Invalid resource");
      }

      const ok = await assertResourceInWorkspace(
        workspaceId,
        resourceType,
        resourceId,
      );
      if (!ok) {
        return fail(c, 404, "Resource not found");
      }

      let channel: INotificationRuleChannel;

      if (ruleId && Types.ObjectId.isValid(ruleId)) {
        const rule = await NotificationRule.findOne({
          _id: new Types.ObjectId(ruleId),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (!rule) {
          return fail(c, 404, "Rule not found");
        }
        channel = rule.channel as INotificationRuleChannel;
      } else {
        const parsed = parseChannelFromBody(body);
        if (!parsed) {
          return fail(c, 400, "Invalid channel configuration");
        }
        channel = encryptNotificationChannel(parsed.channel);
      }

      const resourceName = await resolveResourceDisplayName({
        resourceType,
        resourceId,
      });

      const payload = buildOutboundPayload({
        event: {
          workspaceId,
          resourceType,
          resourceId,
          runId: "test-run",
          status: trigger === "success" ? "completed" : "failed",
          success: trigger === "success",
          triggerType: "manual",
          completedAt: new Date().toISOString(),
          durationMs: 0,
          errorMessage:
            trigger === "failure" ? "Test failure notification" : undefined,
        },
        resourceName,
        trigger,
      });

      const channelType = channel.type as NotificationChannelType;

      if (ruleId && Types.ObjectId.isValid(ruleId)) {
        const idempotencyKey = `test:${hashForIdempotencySecret(`${workspaceId}:${resourceType}:${resourceId}:${Date.now()}:${Math.random()}`)}`;
        await inngest.send({
          name: "notification/deliver",
          data: {
            workspaceId,
            ruleId,
            resourceType,
            resourceId,
            runId: "test-run",
            trigger,
            channelType,
            idempotencyKey,
            payload,
          } satisfies NotificationDeliverJobData,
        });
        return c.json({ success: true, message: "Test notification queued" });
      }

      await deliverNotificationJobDirect(
        {
          workspaceId,
          resourceType,
          resourceId,
          runId: "test-run",
          trigger,
          channelType,
          idempotencyKey: "test:direct",
          payload,
        },
        channel,
      );

      return c.json({ success: true, message: "Test notification sent" });
    } catch (error) {
      logger.error("Test notification failed", { error });
      return failFromThrown(c, error, "Failed to queue test notification");
    }
  },
);
