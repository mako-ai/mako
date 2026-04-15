/**
 * Usage Limit Middleware
 *
 * Checks billing plan limits and model access before allowing agent requests.
 * When BILLING_ENABLED is false, this middleware is a no-op.
 */

import { Workspace, IWorkspaceBilling } from "../database/workspace-schema";
import {
  getEffectiveBillingPlan,
  isBillingEnabled,
  PLAN_DEFINITIONS,
} from "./config";
import { checkUsageLimit, canUseModel } from "./billing.service";

interface UsageLimitResult {
  allowed: boolean;
  statusCode?: 402 | 403;
  error?: {
    code: string;
    message: string;
    plan?: string;
    currentUsageUsd?: number;
    quotaUsd?: number;
  };
}

/**
 * Check whether a workspace is allowed to make an agent request
 * for the given model. Returns { allowed: true } or an error payload.
 */
export async function checkBillingLimits(
  workspaceId: string,
  modelId: string,
): Promise<UsageLimitResult> {
  if (!isBillingEnabled()) {
    return { allowed: true };
  }

  const workspace = await Workspace.findById(workspaceId).select("billing");
  if (!workspace) {
    return {
      allowed: false,
      statusCode: 403,
      error: { code: "workspace_not_found", message: "Workspace not found" },
    };
  }

  const billing: IWorkspaceBilling = workspace.billing || {
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    usageQuotaUsd: PLAN_DEFINITIONS.free.usageQuotaUsd,
    hardLimitUsd: PLAN_DEFINITIONS.free.hardLimitUsd,
    plan: "free",
  };

  // For canceled/past_due subscriptions, degrade to free tier behavior
  const effectivePlan = getEffectiveBillingPlan(billing);

  const effectiveBilling: IWorkspaceBilling = {
    ...billing,
    plan: effectivePlan,
    usageQuotaUsd:
      effectivePlan === "free"
        ? PLAN_DEFINITIONS.free.usageQuotaUsd
        : billing.usageQuotaUsd,
    hardLimitUsd:
      effectivePlan === "free"
        ? PLAN_DEFINITIONS.free.hardLimitUsd
        : billing.hardLimitUsd,
  };

  // Check model access
  const modelCheck = await canUseModel(effectiveBilling, modelId);
  if (!modelCheck.allowed) {
    return {
      allowed: false,
      statusCode: 403,
      error: {
        code: "model_not_available",
        message: modelCheck.reason || "Model not available on current plan",
        plan: effectivePlan,
      },
    };
  }

  // Check usage limit
  const usageCheck = await checkUsageLimit(workspaceId, effectiveBilling);
  if (!usageCheck.allowed) {
    return {
      allowed: false,
      statusCode: 402,
      error: {
        code: "usage_limit_exceeded",
        message:
          usageCheck.reason || "Usage limit exceeded. Upgrade to continue.",
        plan: effectivePlan,
        currentUsageUsd: usageCheck.currentUsageUsd,
        quotaUsd: usageCheck.quotaUsd,
      },
    };
  }

  return { allowed: true };
}
