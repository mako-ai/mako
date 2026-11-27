/**
 * Stripe Webhook Handler
 *
 * Mounted at /api/webhooks/stripe (no auth middleware — uses Stripe signature verification).
 * Syncs subscription lifecycle events back to workspace billing state.
 */

import { createRoute } from "@hono/zod-openapi";
import Stripe from "stripe";
import { workspaceRepo } from "../repositories/workspaces";
import {
  isBillingEnabled,
  STRIPE_BILLING_API_VERSION,
  getStripeSecretKey,
  getStripeWebhookSecret,
} from "../billing/config";
import {
  syncSubscriptionToWorkspace,
  handleSubscriptionDeleted,
} from "../billing/billing.service";
import { loggers } from "../logging";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";
import { fail } from "./lib/respond";

const logger = loggers.api("stripe-webhook");

export const stripeWebhookRoutes = createRouter();

/**
 * POST /api/webhooks/stripe
 *
 * Raw body is required for signature verification.
 * Hono provides the raw body via c.req.text().
 */
stripeWebhookRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Webhooks"],
    summary: "Stripe webhook receiver",
    description:
      "Receives Stripe subscription lifecycle events. Public — authenticated via the Stripe signature header, not session/API key.",
    security: [],
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    if (!isBillingEnabled()) {
      return fail(c, 400, "Billing is not enabled");
    }

    let event: Stripe.Event;

    try {
      const stripe = new Stripe(getStripeSecretKey(), {
        apiVersion: STRIPE_BILLING_API_VERSION,
      });

      const rawBody = await c.req.text();
      const signature = c.req.header("stripe-signature");

      if (!signature) {
        return fail(c, 400, "Missing stripe-signature header");
      }

      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        getStripeWebhookSecret(),
      );
    } catch (err) {
      logger.error("Webhook signature verification failed", { error: err });
      return fail(c, 400, "Invalid signature");
    }

    logger.info("Received Stripe webhook", {
      type: event.type,
      id: event.id,
    });

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const workspaceId = session.metadata?.workspaceId;
          const customerId =
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id;

          if (workspaceId && customerId) {
            await workspaceRepo.updateBilling(workspaceId, {
              stripeCustomerId: customerId,
            });
            logger.info("Linked Stripe customer to workspace from checkout", {
              workspaceId,
              customerId,
            });
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;

          let workspaceId: string | undefined =
            subscription.metadata?.workspaceId;

          if (!workspaceId) {
            const customerId =
              typeof subscription.customer === "string"
                ? subscription.customer
                : subscription.customer.id;
            const ws = await workspaceRepo.findByStripeCustomerId(customerId);
            workspaceId = ws?.id;
          }

          await syncSubscriptionToWorkspace(subscription, workspaceId);
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;

          let workspaceId: string | undefined =
            subscription.metadata?.workspaceId;

          if (!workspaceId) {
            const customerId =
              typeof subscription.customer === "string"
                ? subscription.customer
                : subscription.customer.id;
            const ws = await workspaceRepo.findByStripeCustomerId(customerId);
            workspaceId = ws?.id;
          }

          await handleSubscriptionDeleted(subscription, workspaceId);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId =
            typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id;

          if (customerId) {
            await workspaceRepo.markStripeCustomerPastDue(customerId);
            logger.warn(
              "Invoice payment failed, marked workspace as past_due",
              {
                customerId,
              },
            );
          }
          break;
        }

        default:
          logger.debug("Unhandled Stripe event type", { type: event.type });
      }
    } catch (err) {
      logger.error("Error processing Stripe webhook", {
        type: event.type,
        error: err,
      });
      return fail(c, 500, "Webhook processing error");
    }

    return c.json({ received: true });
  },
);
