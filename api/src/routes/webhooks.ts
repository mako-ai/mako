import { createRoute, type RouteHandler, z } from "@hono/zod-openapi";
import { inWorkspace } from "../utils/workspace-scope";
import type { Context } from "hono";
import { Types } from "mongoose";
import {
  Flow,
  WebhookEvent,
  SourceConnection,
} from "../database/workspace-schema";
import { randomUUID } from "crypto";
import { connectorRegistry } from "../connectors/registry";
import {
  admitInlineWebhook,
  retainClosedInlineWebhook,
  type InlineWebhookScope,
} from "../sync-cdc/inline-webhook-admission";
import { isWebhookFlow } from "../services/flow-triggers.service";
import {
  presentedWebhookToken,
  redactWebhookSecretHeaders,
  webhookTokenMatches,
} from "../utils/webhook-token";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers } from "../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  type AuthEnv,
} from "../openapi/core";
import { fail } from "./lib/respond";
import { checkWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.inngest("webhook");

const router = createRouter();

const WebhookParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
});

async function requireWebhookTestAccess(
  c: Context<AuthEnv>,
  workspaceId: string,
) {
  const refused = await checkWorkspaceAccess(c, workspaceId);
  if (refused) return refused;
  c.set("workspaceId", workspaceId);
  return null;
}

/**
 * Webhook endpoint handler
 * URL structure: /api/webhooks/:workspaceId/:flowId
 *
 * Saves the inbound event as a "pending" WebhookEvent and returns 200
 * immediately. The CDC scheduler cron (cdcMaterializeSchedulerFunction)
 * ingests pending events into CdcChangeEvents and triggers materialization —
 * no per-webhook Inngest events are emitted. The legacy real-time webhook
 * processing pipeline (webhook/event.process) has been decommissioned.
 */
const webhookReceiverRoute = createRoute({
  method: "post",
  path: "/webhooks/{workspaceId}/{flowId}",
  tags: ["Webhooks"],
  summary: "Receive an inbound connector webhook",
  description:
    "Inbound webhook receiver for connector flows. Public — authenticated via the connector's signature, or, for connectors without one, the flow's shared secret (X-Mako-Webhook-Token header, Bearer token or ?token=). Not session/API key.",
  security: [],
  request: { params: WebhookParam },
  responses: { ...OPEN_RESPONSES },
});

const receiveWebhook =
  (
    scope?: InlineWebhookScope,
  ): RouteHandler<typeof webhookReceiverRoute, AuthEnv> =>
  async c => {
    const { workspaceId, flowId } = c.req.param();
    const guarded =
      scope?.workspaceId.toHexString() === workspaceId.toLowerCase() &&
      scope.flowId.toHexString() === flowId.toLowerCase()
        ? scope
        : undefined;

    logger.debug("Webhook received", { workspaceId, flowId });

    const rawBodyBuffer = Buffer.from(await c.req.arrayBuffer());
    const rawBodyText = rawBodyBuffer.toString("utf8");
    const headers = c.req.header();
    const query = c.req.query();

    try {
      // By id alone: any flow whose webhook trigger is on takes deliveries,
      // whatever its `type` (isWebhookFlow).
      const flow = await Flow.findOne({
        _id: flowId,
        workspaceId: workspaceId,
      });

      if (!flow || !isWebhookFlow(flow)) {
        logger.warn("Webhook received for invalid flow", { flowId });
        return fail(c, 404, "Invalid webhook endpoint");
      }

      if (!flow.webhookConfig?.enabled) {
        logger.warn("Webhook received for disabled flow", { flowId });
        return fail(c, 403, "Webhook endpoint disabled");
      }

      const sourceConnection = await SourceConnection.findOne(
        inWorkspace(flow.dataSourceId, flow.workspaceId),
      );
      if (!sourceConnection) {
        return fail(c, 404, "Data source not found");
      }

      const connector = connectorRegistry.getConnectorFor(sourceConnection);
      if (!connector) {
        return fail(
          c,
          500,
          `Connector not found for type: ${sourceConnection.type}`,
        );
      }

      let event: any;

      // A boxed connector's events wait in their own lane, pinned to the
      // connection they were verified for: a batch hands a connector only
      // its own connection's events (webhook-batch.ts), and the inline cron
      // never sees them, so a slow box cannot hold up anyone else's. Only a
      // `ws:` connector with CONNECTOR_WEBHOOK_BATCHES on is "box".
      const boxLane = connector.webhookDelivery?.() === "box";
      if (
        guarded &&
        (boxLane ||
          sourceConnection.type !== "claap" ||
          !guarded.sourceConnectionId.equals(sourceConnection._id))
      ) {
        return fail(c, 503, "Webhook admission binding changed");
      }

      if (connector.supportsWebhooks()) {
        const secret = flow.webhookConfig.secret;
        const verify = () =>
          connector.verifyWebhook({
            payload: rawBodyText,
            headers: headers,
            secret,
            query,
          });
        let verificationResult: Awaited<ReturnType<typeof verify>>;
        if (boxLane) {
          try {
            verificationResult = await verify();
          } catch (error) {
            // The check itself could not run (the workspace connector's
            // definition failed to load, say). Nothing was stored, so the
            // vendor must retry: never a 2xx here. In-process connectors
            // keep today's answer (the outer catch).
            logger.error("Webhook verification could not run", {
              flowId,
              error: error instanceof Error ? error.message : String(error),
            });
            return fail(c, 503, "Webhook verification is unavailable");
          }
        } else {
          verificationResult = await verify();
        }

        if (!verificationResult.valid) {
          logger.error("Webhook signature verification failed", {
            error: verificationResult.error,
          });
          return fail(c, 400, verificationResult.error || "Invalid signature");
        }

        event = verificationResult.event;
      } else {
        if (guarded) {
          return fail(c, 503, "Webhook verification is unavailable");
        }
        // No native signature verification: fail closed unless the sender
        // presents the flow's shared secret (utils/webhook-token.ts). A flow
        // without a secret configured takes no deliveries at all.
        if (!flow.webhookConfig.secret) {
          logger.warn("Webhook refused: flow has no shared secret", {
            flowId,
          });
          return fail(
            c,
            401,
            "Webhook secret not configured for this flow. Set one and send it as the X-Mako-Webhook-Token header.",
          );
        }
        if (
          !webhookTokenMatches(
            presentedWebhookToken(headers, query),
            flow.webhookConfig.secret,
          )
        ) {
          logger.warn("Webhook refused: missing or invalid token", { flowId });
          return fail(c, 401, "Invalid webhook token");
        }
        try {
          event = JSON.parse(rawBodyText);
        } catch (e) {
          logger.error("Invalid JSON payload", { error: e });
          return fail(c, 400, "Invalid JSON payload");
        }
      }

      // A boxed connector says where its vendor puts the event id and type
      // (PandaDoc posts a bare array, Claap nests the type); without an id
      // the box lane keys on a hash of the body, never a random id.
      const boxIdentity = boxLane
        ? connector.webhookEventIdentity?.(event, rawBodyText, headers)
        : undefined;

      const eventType =
        boxIdentity?.eventType ||
        event.type ||
        event.event_type ||
        event.action ||
        (event.event?.object_type && event.event?.action
          ? `${event.event.object_type}.${event.event.action}`
          : "unknown");

      if (guarded) {
        // Claap's verifier maps the delivery's eventId to id. Its legacy id
        // fallback is ambiguous here and could conflate two deliveries.
        const eventId = event.eventId;
        if (
          typeof eventId !== "string" ||
          !eventId.trim() ||
          eventId !== event.id
        ) {
          return fail(c, 400, "Claap webhook eventId is required");
        }
        const admitted = await admitInlineWebhook(Flow.db, guarded, session =>
          WebhookEvent.updateOne(
            {
              flowId: guarded.flowId,
              workspaceId: guarded.workspaceId,
              dataSourceId: sourceConnection._id,
              eventId,
            },
            {
              $setOnInsert: {
                eventType,
                rawPayload: event,
                receivedAt: new Date(),
                status: "pending",
              },
            },
            { upsert: true, session },
          ).exec(),
        );
        if (!admitted.admitted) {
          await retainClosedInlineWebhook(Flow.db, guarded, {
            sourceConnectionId: sourceConnection._id,
            eventId,
            eventType,
            rawPayload: event,
          });
        }
        return c.json({ received: true, eventId }, 200);
      }

      const webhookEvent = new WebhookEvent({
        flowId,
        workspaceId,
        ...(boxLane ? { lane: "box", dataSourceId: sourceConnection._id } : {}),
        eventId:
          boxIdentity?.eventId || event.id || event.event?.id || randomUUID(),
        eventType,
        receivedAt: new Date(),
        status: "pending",
        attempts: 0,
        rawPayload: event,
        // Minus any shared-secret header: a token must never sit in Mongo.
        // A `shared-secret` connector's declared header holds the secret too.
        signature: JSON.stringify(
          redactWebhookSecretHeaders(
            headers,
            connector.webhookSecretHeaders?.() ?? [],
          ),
        ),
      });

      await webhookEvent.save();

      await Flow.updateOne(
        { _id: flowId },
        {
          $set: { "webhookConfig.lastReceivedAt": new Date() },
          $inc: { "webhookConfig.totalReceived": 1 },
        },
      );

      // Save and return. The CDC scheduler cron ingests pending events into
      // CdcChangeEvents and triggers materialization (entity filtering happens
      // at ingest time). No per-webhook Inngest event is emitted.
      logger.info("Webhook saved for CDC cron ingest", {
        eventId: webhookEvent.eventId,
        flowId,
      });
      return c.json({ received: true, eventId: webhookEvent.eventId }, 200);
    } catch (error) {
      if (guarded) {
        logger.error("Guarded webhook intake could not confirm receipt", {
          flowId,
        });
        return fail(c, 503, "Webhook receipt unavailable");
      }
      logger.error("Webhook handler error", { error });
      return c.json(
        { received: false, error: "Internal processing error" },
        200,
      );
    }
  };

/** The optional scope must be configured on every receiver before closing its gate. */
export function registerWebhookReceiver(
  receiver: ReturnType<typeof createRouter>,
  scope?: InlineWebhookScope,
) {
  return receiver.openapi(webhookReceiverRoute, receiveWebhook(scope));
}

registerWebhookReceiver(router);

/**
 * Test webhook endpoint
 * Sends a test event to verify webhook configuration
 */
router.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/{workspaceId}/{flowId}/test",
    tags: ["Webhooks"],
    summary: "Send a test webhook event",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { params: WebhookParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId, flowId } = c.req.param();

    try {
      if (
        !Types.ObjectId.isValid(workspaceId) ||
        !Types.ObjectId.isValid(flowId)
      ) {
        return fail(c, 400, "Invalid webhook test endpoint");
      }

      const accessDenied = await requireWebhookTestAccess(c, workspaceId);
      if (accessDenied) return accessDenied;

      const flow = await Flow.findOne({
        _id: flowId,
        workspaceId: workspaceId,
      });

      if (!flow || !isWebhookFlow(flow)) {
        return fail(c, 404, "Webhook flow not found");
      }

      // Create a test event
      const testEvent = {
        id: `test_${randomUUID()}`,
        type: "test.webhook",
        created: Math.floor(Date.now() / 1000),
        data: {
          message: "This is a test webhook event",
          timestamp: new Date().toISOString(),
        },
      };

      // Store the test event
      const webhookEvent = new WebhookEvent({
        flowId,
        workspaceId,
        eventId: testEvent.id,
        eventType: testEvent.type,
        receivedAt: new Date(),
        status: "pending",
        attempts: 0,
        rawPayload: testEvent,
      });

      await webhookEvent.save();

      return c.json({
        success: true,
        message:
          "Test webhook saved — will be ingested on the next CDC cron cycle (<=5 min)",
        eventId: testEvent.id,
      });
    } catch (error) {
      logger.error("Test webhook error", { error });
      return fail(c, 500, "Failed to send test webhook");
    }
  },
);

export { router as webhookRoutes };
