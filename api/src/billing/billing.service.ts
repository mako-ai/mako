/**
 * Billing Service
 *
 * Handles Stripe operations (customer creation, checkout, portal) and
 * local usage aggregation from the LlmUsage collection.
 */

import Stripe from "stripe";
import { ObjectId } from "mongodb";
import {
  Workspace,
  IWorkspace,
  IWorkspaceBilling,
} from "../database/workspace-schema";
import { LlmUsage } from "../database/schema";
import {
  getStripeSecretKey,
  getStripeProPriceId,
  getModelTier,
  isModelAvailableForPlan,
  PLAN_DEFINITIONS,
  type BillingPlan,
} from "./config";
import { loggers } from "../logging";

const logger = loggers.app();

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getStripeSecretKey(), {
      apiVersion: "2025-12-18.acacia" as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

/**
 * Get or create a Stripe Customer for the workspace.
 * Stores the customer ID on the workspace billing subdocument.
 */
export async function getOrCreateStripeCustomer(
  workspace: IWorkspace,
  userEmail: string,
): Promise<string> {
  if (workspace.billing?.stripeCustomerId) {
    return workspace.billing.stripeCustomerId;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: userEmail,
    metadata: {
      workspaceId: workspace._id.toString(),
      workspaceName: workspace.name,
    },
  });

  await Workspace.updateOne(
    { _id: workspace._id },
    { $set: { "billing.stripeCustomerId": customer.id } },
  );

  logger.info("Created Stripe customer", {
    workspaceId: workspace._id.toString(),
    customerId: customer.id,
  });

  return customer.id;
}

/**
 * Create a Stripe Checkout Session for upgrading to Pro.
 * Returns the checkout URL for redirect.
 */
export async function createCheckoutSession(
  workspace: IWorkspace,
  userEmail: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(workspace, userEmail);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [
      {
        price: getStripeProPriceId(),
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      workspaceId: workspace._id.toString(),
    },
    subscription_data: {
      metadata: {
        workspaceId: workspace._id.toString(),
      },
    },
  });

  if (!session.url) {
    throw new Error("Stripe Checkout Session did not return a URL");
  }

  return session.url;
}

/**
 * Create a Stripe Customer Portal session.
 * Returns the portal URL for redirect.
 */
export async function createPortalSession(
  workspace: IWorkspace,
  userEmail: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getStripe();
  const customerId = await getOrCreateStripeCustomer(workspace, userEmail);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * Aggregate LLM usage cost for a workspace in the current billing period.
 */
export async function getCurrentPeriodUsage(
  workspaceId: string,
  periodStart?: Date | null,
): Promise<{
  totalCostUsd: number;
  invocationCount: number;
  totalTokens: number;
}> {
  const matchFilter: Record<string, unknown> = {
    workspaceId: new ObjectId(workspaceId),
  };

  if (periodStart) {
    matchFilter.createdAt = { $gte: periodStart };
  } else {
    // Default to current calendar month
    const now = new Date();
    matchFilter.createdAt = {
      $gte: new Date(now.getFullYear(), now.getMonth(), 1),
    };
  }

  const [result] = await LlmUsage.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: null,
        totalCostUsd: { $sum: "$costUsd" },
        invocationCount: { $sum: 1 },
        totalTokens: { $sum: "$totalTokens" },
      },
    },
    { $project: { _id: 0 } },
  ]);

  return (
    result ?? {
      totalCostUsd: 0,
      invocationCount: 0,
      totalTokens: 0,
    }
  );
}

/**
 * Check whether a workspace can use a specific model based on its plan.
 */
export function canUseModel(
  billing: IWorkspaceBilling,
  modelId: string,
): { allowed: boolean; reason?: string } {
  const plan = billing.plan || "free";

  if (isModelAvailableForPlan(modelId, plan)) {
    return { allowed: true };
  }

  const modelTier = getModelTier(modelId);
  return {
    allowed: false,
    reason: `Model requires a ${modelTier} plan. Current plan: ${plan}`,
  };
}

/**
 * Check whether a workspace has exceeded its usage quota.
 */
export async function checkUsageLimit(
  workspaceId: string,
  billing: IWorkspaceBilling,
): Promise<{
  allowed: boolean;
  currentUsageUsd: number;
  quotaUsd: number;
  reason?: string;
}> {
  const plan = billing.plan || "free";
  const planDef = PLAN_DEFINITIONS[plan];
  const quotaUsd = billing.usageQuotaUsd ?? planDef.usageQuotaUsd;
  const hardLimit = billing.hardLimitUsd ?? planDef.hardLimitUsd;

  const usage = await getCurrentPeriodUsage(
    workspaceId,
    billing.currentPeriodStart,
  );

  const effectiveLimit = hardLimit ?? quotaUsd;

  if (plan === "free" && usage.totalCostUsd >= effectiveLimit) {
    return {
      allowed: false,
      currentUsageUsd: usage.totalCostUsd,
      quotaUsd,
      reason: `Free plan usage limit reached ($${usage.totalCostUsd.toFixed(2)} / $${effectiveLimit.toFixed(2)}). Upgrade to Pro for more usage.`,
    };
  }

  // Pro/Enterprise: only block if hard limit is set and exceeded
  if (hardLimit != null && usage.totalCostUsd >= hardLimit) {
    return {
      allowed: false,
      currentUsageUsd: usage.totalCostUsd,
      quotaUsd,
      reason: `Hard usage limit reached ($${usage.totalCostUsd.toFixed(2)} / $${hardLimit.toFixed(2)}).`,
    };
  }

  return {
    allowed: true,
    currentUsageUsd: usage.totalCostUsd,
    quotaUsd,
  };
}

/**
 * Get full billing status for a workspace (for the /status endpoint).
 */
export async function getBillingStatus(workspaceId: string): Promise<{
  plan: BillingPlan;
  subscriptionStatus: string | null;
  currentUsageUsd: number;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  invocationCount: number;
  totalTokens: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  hasStripeCustomer: boolean;
  hasSubscription: boolean;
}> {
  const workspace = await Workspace.findById(workspaceId).select("billing");
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const billing = workspace.billing || {
    plan: "free" as const,
    subscriptionStatus: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    usageQuotaUsd: PLAN_DEFINITIONS.free.usageQuotaUsd,
    hardLimitUsd: PLAN_DEFINITIONS.free.hardLimitUsd,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  };

  const plan = (billing.plan || "free") as BillingPlan;
  const planDef = PLAN_DEFINITIONS[plan];

  const usage = await getCurrentPeriodUsage(
    workspaceId,
    billing.currentPeriodStart,
  );

  return {
    plan,
    subscriptionStatus: billing.subscriptionStatus,
    currentUsageUsd: usage.totalCostUsd,
    usageQuotaUsd: billing.usageQuotaUsd ?? planDef.usageQuotaUsd,
    hardLimitUsd: billing.hardLimitUsd ?? planDef.hardLimitUsd,
    invocationCount: usage.invocationCount,
    totalTokens: usage.totalTokens,
    currentPeriodStart: billing.currentPeriodStart,
    currentPeriodEnd: billing.currentPeriodEnd,
    hasStripeCustomer: !!billing.stripeCustomerId,
    hasSubscription: !!billing.stripeSubscriptionId,
  };
}

/**
 * Sync subscription data from a Stripe Subscription object to the workspace.
 */
export async function syncSubscriptionToWorkspace(
  subscription: Stripe.Subscription,
  workspaceId?: string,
): Promise<void> {
  const wsId = workspaceId || subscription.metadata?.workspaceId;
  if (!wsId) {
    logger.warn("No workspaceId found on subscription metadata", {
      subscriptionId: subscription.id,
    });
    return;
  }

  const status = subscription.status;
  const plan: BillingPlan =
    status === "active" || status === "trialing" ? "pro" : "free";
  const planDef = PLAN_DEFINITIONS[plan];

  const newPeriodStart = new Date(subscription.current_period_start * 1000);

  const update: Record<string, unknown> = {
    "billing.stripeSubscriptionId": subscription.id,
    "billing.subscriptionStatus": status,
    "billing.currentPeriodStart": newPeriodStart,
    "billing.currentPeriodEnd": new Date(
      subscription.current_period_end * 1000,
    ),
    "billing.plan": plan,
    "billing.usageQuotaUsd": planDef.usageQuotaUsd,
    "billing.hardLimitUsd": planDef.hardLimitUsd,
    "settings.billingTier": plan,
  };

  // Only reset the overage tracker when the billing period actually changes
  // (i.e. subscription renewal), not on every subscription.updated event
  // (which also fires for card updates, metadata edits, etc.)
  const ws = await Workspace.findById(wsId).select(
    "billing.currentPeriodStart",
  );
  const existingPeriodStart = ws?.billing?.currentPeriodStart;
  const periodChanged =
    !existingPeriodStart ||
    existingPeriodStart.getTime() !== newPeriodStart.getTime();
  if (periodChanged) {
    update["billing.lastReportedOverageCents"] = 0;
  }

  // Also store customer ID if present
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (customerId) {
    update["billing.stripeCustomerId"] = customerId;
  }

  await Workspace.updateOne({ _id: new ObjectId(wsId) }, { $set: update });

  logger.info("Synced subscription to workspace", {
    workspaceId: wsId,
    subscriptionId: subscription.id,
    status,
    plan,
  });
}

/**
 * Handle subscription deletion (canceled/expired).
 */
export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  workspaceId?: string,
): Promise<void> {
  const wsId = workspaceId || subscription.metadata?.workspaceId;
  if (!wsId) return;

  const freeDef = PLAN_DEFINITIONS.free;

  await Workspace.updateOne(
    { _id: new ObjectId(wsId) },
    {
      $set: {
        "billing.stripeSubscriptionId": null,
        "billing.subscriptionStatus": "canceled",
        "billing.currentPeriodStart": null,
        "billing.currentPeriodEnd": null,
        "billing.plan": "free",
        "billing.usageQuotaUsd": freeDef.usageQuotaUsd,
        "billing.hardLimitUsd": freeDef.hardLimitUsd,
        "settings.billingTier": "free",
      },
    },
  );

  logger.info("Subscription deleted, workspace reverted to free plan", {
    workspaceId: wsId,
    subscriptionId: subscription.id,
  });
}
