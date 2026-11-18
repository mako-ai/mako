import { z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { RepoRequiredError } from "../../apps/config";
import { Flow, WebhookEvent } from "../../database/workspace-schema";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { isWebhookFlow } from "../../services/flow-triggers.service";
import {
  persistProvisionedWebhook,
  provisionFlowWebhook,
} from "../../services/flow-webhook-provision.service";
import { fail } from "../lib/respond";
import {
  ANY_JSON_BODY,
  assertFlowRepo,
  assertOwnerOrAdmin,
  commitFlowFileOrFail,
  findFlow,
  flowFailure,
  flowRoute,
  logger,
  queryParam,
  repoRequired,
  type FlowRouter,
} from "./shared";

export function registerWebhooksRoutes(flowRoutes: FlowRouter): void {
  // POST /api/workspaces/:workspaceId/flows/:flowId/webhook/provision
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/webhook/provision", { body: ANY_JSON_BODY }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const flowId = c.req.param("flowId") as string;
        const authorizationError = await assertOwnerOrAdmin(
          c as AuthenticatedContext,
          workspaceId,
        );
        if (authorizationError) return authorizationError;

        // Provisioning rewrites the webhook stanza of `flows/<slug>.yml`
        // (RFC #904 decision 1).
        await assertFlowRepo(workspaceId);

        const body = await c.req.json().catch(() => ({}));

        const flow = await findFlow(workspaceId, flowId);
        if (!flow) {
          return fail(c, 404, "Flow not found");
        }
        const { endpoint, created, webhookConfig, connectorType } =
          await provisionFlowWebhook({ workspaceId, flow, body });
        await persistProvisionedWebhook(flow);
        {
          const failed = await commitFlowFileOrFail(c, flow, c.get("user")?.id);
          if (failed) return failed;
        }
        await flow.save();

        if (!webhookConfig.secret) {
          // Some providers create the endpoint but omit the signing secret from
          // the API response (e.g. Stripe restricted keys, rk_…). Without it the
          // flow can't verify incoming webhooks, so surface an actionable error
          // instead of reporting a misleading success. The endpoint URL is still
          // persisted above so the user can find/reuse it.
          return fail(
            c,
            400,
            `The ${connectorType} webhook endpoint` +
              (created.providerWebhookId
                ? ` (${created.providerWebhookId})`
                : "") +
              " was created, but the provider did not return a signing secret. " +
              "This typically happens with restricted API keys. Reveal the " +
              "signing secret in your provider's dashboard and paste it into the " +
              "Webhook Secret field, or use a full-access API key and re-provision.",
          );
        }

        return c.json({
          success: true,
          data: {
            endpoint,
            providerWebhookId: created.providerWebhookId,
            webhookSecret: webhookConfig.secret || null,
            connectorType,
          },
        });
      } catch (error) {
        // The repo gate is a precondition, not a failure: 412 with an
        // actionable message rather than a 500 the user cannot act on.
        if (error instanceof RepoRequiredError) return repoRequired(c, error);
        return flowFailure(c, error, 400);
      }
    },
  );

  // GET webhook events for a flow
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/webhook/events", {
      query: z.object({
        limit: queryParam("limit"),
        offset: queryParam("offset"),
        status: queryParam("status"),
        applyStatus: queryParam("applyStatus"),
      }),
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const limit = parseInt(c.req.query("limit") || "50");
        const offset = parseInt(c.req.query("offset") || "0");
        const status = c.req.query("status");

        const flow = await Flow.findOne({
          _id: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        });

        if (!flow || !isWebhookFlow(flow)) {
          return fail(c, 404, "Webhook flow not found");
        }

        const applyStatus = c.req.query("applyStatus");

        const query: any = {
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        };

        if (status) {
          query.status = status;
        }
        if (applyStatus) {
          query.applyStatus = applyStatus;
        }

        const events = await WebhookEvent.find(query)
          .sort({ receivedAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean();

        const total = await WebhookEvent.countDocuments(query);

        return c.json({
          success: true,
          data: {
            total,
            limit,
            offset,
            events: events.map(event => ({
              id: event._id,
              eventId: event.eventId,
              eventType: event.eventType,
              receivedAt: event.receivedAt,
              processedAt: event.processedAt,
              status: event.status,
              applyStatus: event.applyStatus,
              attempts: event.attempts,
              error: event.error,
              applyError: event.applyError,
              entity: event.entity,
              operation: event.operation,
              processingDurationMs: event.processingDurationMs,
            })),
          },
        });
      } catch (error) {
        logger.error("Error getting webhook events", { error });
        return fail(c, 500, "Server error");
      }
    },
  );

  // GET webhook event details
  flowRoutes.openapi(
    flowRoute("get", "/{flowId}/webhook/events/{eventId}"),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const eventId = c.req.param("eventId");

        const event = await WebhookEvent.findOne({
          _id: new Types.ObjectId(eventId),
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).lean();

        if (!event) {
          return fail(c, 404, "Webhook event not found");
        }

        return c.json({ success: true, data: event });
      } catch (error) {
        logger.error("Error getting webhook event details", { error });
        return fail(c, 500, "Server error");
      }
    },
  );

  // POST retry webhook event — resets to pending.
  // CDC: 2-min cron picks it up. Non-CDC: enqueues via Inngest.
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/webhook/events/{eventId}/retry", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");
        const eventId = c.req.param("eventId");

        const event = await WebhookEvent.findOneAndUpdate(
          {
            _id: new Types.ObjectId(eventId),
            flowId: new Types.ObjectId(flowId),
            workspaceId: new Types.ObjectId(workspaceId),
            status: { $in: ["failed", "completed"] },
          },
          {
            $set: { status: "pending" },
            $unset: { applyError: "", error: "", processedAt: "" },
          },
          { returnDocument: "after", projection: { eventId: 1, flowId: 1 } },
        );

        if (!event) {
          return fail(c, 404, "Webhook event not found or cannot be retried");
        }

        // All webhook flows are CDC: the scheduler cron re-ingests pending events.
        return c.json({
          success: true,
          message:
            "Webhook event reset to pending — will be picked up by the next CDC cron cycle",
          data: { eventId },
        });
      } catch (error) {
        logger.error("Error retrying webhook event", { error });
        return fail(c, 500, "Server error");
      }
    },
  );

  // POST retry all failed webhook events for a flow — resets to pending.
  // CDC: cron picks up. Non-CDC: enqueues each via Inngest.
  flowRoutes.openapi(
    flowRoute("post", "/{flowId}/webhook/events/retry-all-failed", {
      body: ANY_JSON_BODY,
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const flowId = c.req.param("flowId");

        const failedEvents = await WebhookEvent.find({
          flowId: new Types.ObjectId(flowId),
          workspaceId: new Types.ObjectId(workspaceId),
          status: "failed",
          attempts: { $lt: 10 },
        })
          .select("_id eventId flowId")
          .limit(500)
          .lean();

        if (failedEvents.length === 0) {
          return c.json({ success: true, data: { retried: 0 } });
        }

        await WebhookEvent.updateMany(
          { _id: { $in: failedEvents.map(e => e._id) } },
          {
            $set: { status: "pending" },
            $unset: { applyError: "", error: "", processedAt: "" },
          },
        );

        // All webhook flows are CDC: the scheduler cron re-ingests pending events.
        return c.json({
          success: true,
          data: {
            retried: failedEvents.length,
            total: failedEvents.length,
          },
        });
      } catch (error) {
        logger.error("Error retrying all failed webhook events", { error });
        return fail(c, 500, "Server error");
      }
    },
  );
}
