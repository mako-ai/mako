/**
 * Billing Service
 *
 * Handles Stripe operations (customer creation, checkout, portal) and
 * local usage aggregation from the LlmUsage collection.
 */

import Stripe from "stripe";
import { SUBSCRIPTION_STATUSES } from "../database/pg/schema/workspaces";
import { usageStatsRepo } from "../repositories/usage-stats";
import {
  workspaceRepo,
  type SubscriptionStatus,
  type UpdateBillingPatch,
  type WorkspaceBilling,
  type WorkspaceRecord,
} from "../repositories/workspaces";
import {
  STRIPE_BILLING_API_VERSION,
  getStripeSecretKey,
  getStripeProPriceId,
  getStripeOveragePriceId,
  getModelTier,
  isModelAvailableForPlan,
  PLAN_DEFINITIONS,
  startOfUtcMonth,
  type BillingPlan,
} from "./config";
import { loggers } from "../logging";

const logger = loggers.app();

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getStripeSecretKey(), {
      apiVersion: STRIPE_BILLING_API_VERSION,
    });
  }
  return _stripe;
}

/**
 * Get or create a Stripe Customer for the workspace.
 *
 * Dedup strategy (prevents orphan/duplicate customers):
 *   1. Local fast path: reuse `workspace.billing.stripeCustomerId` if set.
 *   2. Stripe-side search by `metadata.workspaceId` — recovers from a prior
 *      `customers.create` that succeeded in Stripe but failed to persist locally.
 *   3. Cold path: `customers.create`, then atomic local upsert (`findOneAndUpdate`
 *      gated on `stripeCustomerId: null`) so concurrent callers converge on a
 *      single id rather than both writing their own.
 *
 * Only `createCheckoutSession` should call this. The portal path must never
 * create a customer.
 */
type BillingWorkspaceLike = {
  _id: { toString(): string } | string;
  name: string;
  billing?: Partial<WorkspaceBilling>;
};

export async function getOrCreateStripeCustomer(
  workspace: BillingWorkspaceLike | WorkspaceRecord,
  userEmail: string,
): Promise<string> {
  if (workspace.billing?.stripeCustomerId) {
    return workspace.billing.stripeCustomerId;
  }

  const stripe = getStripe();
  const workspaceId = workspace._id.toString();

  const existing = await stripe.customers.search({
    query: `metadata['workspaceId']:'${workspaceId}'`,
    limit: 1,
  });

  let customerId: string;
  if (existing.data[0]) {
    customerId = existing.data[0].id;
    logger.info("Recovered existing Stripe customer from metadata search", {
      workspaceId,
      customerId,
    });
  } else {
    const customer = await stripe.customers.create({
      email: userEmail,
      name: workspace.name,
      metadata: {
        workspaceId,
        workspaceName: workspace.name,
      },
    });
    customerId = customer.id;
    logger.info("Created Stripe customer", { workspaceId, customerId });
  }

  const claimed = await workspaceRepo.claimStripeCustomerIdIfUnset(
    workspaceId,
    customerId,
  );

  if (!claimed) {
    const current = await workspaceRepo.findById(workspaceId);
    const winnerId = current?.billing?.stripeCustomerId;
    if (winnerId && winnerId !== customerId) {
      logger.warn("Concurrent getOrCreateStripeCustomer race lost", {
        workspaceId,
        winnerCustomerId: winnerId,
        loserCustomerId: customerId,
      });
      return winnerId;
    }
  }

  return customerId;
}

/**
 * Create a Stripe Checkout Session for upgrading to Pro.
 * Returns the checkout URL for redirect.
 */
export async function createCheckoutSession(
  workspace: BillingWorkspaceLike | WorkspaceRecord,
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
      {
        price: getStripeOveragePriceId(),
      },
    ],
    allow_promotion_codes: true,
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
 * Thrown when a portal session is requested for a workspace that has no
 * Stripe customer yet. Callers (the HTTP route) should translate this to a
 * 400 response. The portal must never create a customer — that's the
 * checkout path's job.
 */
export class PortalUnavailableError extends Error {
  constructor(message = "Workspace has no billing customer yet") {
    super(message);
    this.name = "PortalUnavailableError";
  }
}

/**
 * Create a Stripe Customer Portal session. Requires an existing customer on
 * the workspace — throws `PortalUnavailableError` otherwise.
 */
export async function createPortalSession(
  workspace: BillingWorkspaceLike | WorkspaceRecord,
  returnUrl: string,
): Promise<string> {
  const customerId = workspace.billing?.stripeCustomerId;
  if (!customerId) {
    throw new PortalUnavailableError();
  }

  const stripe = getStripe();
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
  const from = periodStart ?? startOfUtcMonth();
  const summary = await usageStatsRepo.getWorkspaceLlmUsageSummary(
    workspaceId,
    { from },
  );

  return {
    totalCostUsd: summary.totalCostUsd,
    invocationCount: summary.invocationCount,
    totalTokens: summary.totalTokens,
  };
}

/**
 * Check whether a workspace can use a specific model based on its plan.
 */
export async function canUseModel(
  billing: Pick<WorkspaceBilling, "plan">,
  modelId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const plan = billing.plan || "free";

  if (await isModelAvailableForPlan(modelId, plan)) {
    return { allowed: true };
  }

  const modelTier = await getModelTier(modelId);
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
  billing: Pick<
    WorkspaceBilling,
    "plan" | "usageQuotaUsd" | "hardLimitUsd" | "currentPeriodStart"
  >,
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
  const workspace = await workspaceRepo.findById(workspaceId);
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

const ALLOWED_SUBSCRIPTION_STATUSES = new Set<string>(SUBSCRIPTION_STATUSES);

function normalizeStripeSubscriptionStatus(
  rawStatus: Stripe.Subscription.Status | string,
): SubscriptionStatus {
  if (ALLOWED_SUBSCRIPTION_STATUSES.has(rawStatus)) {
    return rawStatus as SubscriptionStatus;
  }
  logger.warn(
    "Unrecognized Stripe subscription status; falling back to canceled",
    {
      rawStatus,
    },
  );
  return "canceled";
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

  const status = normalizeStripeSubscriptionStatus(subscription.status);
  const plan: BillingPlan =
    status === "active" || status === "trialing" ? "pro" : "free";
  const planDef = PLAN_DEFINITIONS[plan];

  const periodStartTs =
    (subscription as any).current_period_start ??
    (subscription.items?.data?.[0] as any)?.current_period_start;
  const periodEndTs =
    (subscription as any).current_period_end ??
    (subscription.items?.data?.[0] as any)?.current_period_end;

  const newPeriodStart = periodStartTs
    ? new Date(periodStartTs * 1000)
    : new Date();
  const newPeriodEnd = periodEndTs ? new Date(periodEndTs * 1000) : null;

  const patch: UpdateBillingPatch = {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: status,
    currentPeriodStart: newPeriodStart,
    ...(newPeriodEnd && { currentPeriodEnd: newPeriodEnd }),
    plan,
    usageQuotaUsd: planDef.usageQuotaUsd,
    hardLimitUsd: planDef.hardLimitUsd,
    settingsBillingTier: plan,
  };

  // Only reset the overage tracker when the billing period actually changes
  // (i.e. subscription renewal), not on every subscription.updated event
  // (which also fires for card updates, metadata edits, etc.)
  const ws = await workspaceRepo.findById(wsId);
  const existingPeriodStart = ws?.billing?.currentPeriodStart;
  const periodChanged =
    !existingPeriodStart ||
    existingPeriodStart.getTime() !== newPeriodStart.getTime();
  if (periodChanged) {
    patch.lastReportedOverageCents = 0;
    patch.pendingReportedOverageCents = null;
    patch.pendingMeterEventIdempotencyKey = null;
  }

  // Also store customer ID if present
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (customerId) {
    patch.stripeCustomerId = customerId;
  }

  await workspaceRepo.updateBilling(wsId, patch);

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

  await workspaceRepo.updateBilling(wsId, {
    stripeSubscriptionId: null,
    subscriptionStatus: "canceled",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    plan: "free",
    usageQuotaUsd: freeDef.usageQuotaUsd,
    hardLimitUsd: freeDef.hardLimitUsd,
    lastReportedOverageCents: 0,
    pendingReportedOverageCents: null,
    pendingMeterEventIdempotencyKey: null,
    settingsBillingTier: "free",
  });

  logger.info("Subscription deleted, workspace reverted to free plan", {
    workspaceId: wsId,
    subscriptionId: subscription.id,
  });
}
