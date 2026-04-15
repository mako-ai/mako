/**
 * Stripe Webhook Handler
 *
 * Mounted at /api/webhooks/stripe (no auth middleware — uses Stripe signature verification).
 * Syncs subscription lifecycle events back to workspace billing state.
 */

import { Hono } from "hono";
import Stripe from "stripe";
import { Workspace } from "../database/workspace-schema";
import {
  isBillingEnabled,
  getStripeSecretKey,
  getStripeWebhookSecret,
} from "../billing/config";
import {
  syncSubscriptionToWorkspace,
  handleSubscriptionDeleted,
} from "../billing/billing.service";
import { loggers } from "../logging";

const logger = loggers.api("stripe-webhook");

export const stripeWebhookRoutes = new Hono();

/**
 * POST /api/webhooks/stripe
 *
 * Raw body is required for signature verification.
 * Hono provides the raw body via c.req.text().
 */
stripeWebhookRoutes.post("/", async c => {
  if (!isBillingEnabled()) {
    return c.json({ error: "Billing is not enabled" }, 400);
  }

  let event: Stripe.Event;

  try {
    const stripe = new Stripe(getStripeSecretKey());

    const rawBody = await c.req.text();
    const signature = c.req.header("stripe-signature");

    if (!signature) {
      return c.json({ error: "Missing stripe-signature header" }, 400);
    }

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      getStripeWebhookSecret(),
    );
  } catch (err) {
    logger.error("Webhook signature verification failed", { error: err });
    return c.json({ error: "Invalid signature" }, 400);
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
          await Workspace.updateOne(
            { _id: workspaceId },
            { $set: { "billing.stripeCustomerId": customerId } },
          );
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
          const ws = await Workspace.findOne({
            "billing.stripeCustomerId": customerId,
          }).select("_id");
          workspaceId = ws?._id?.toString();
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
          const ws = await Workspace.findOne({
            "billing.stripeCustomerId": customerId,
          }).select("_id");
          workspaceId = ws?._id?.toString();
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
          await Workspace.updateOne(
            { "billing.stripeCustomerId": customerId },
            { $set: { "billing.subscriptionStatus": "past_due" } },
          );
          logger.warn("Invoice payment failed, marked workspace as past_due", {
            customerId,
          });
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
    return c.json({ error: "Webhook processing error" }, 500);
  }

  return c.json({ received: true });
});
