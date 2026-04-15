import type { AIModel } from "../lib/api-types";
import type { BillingStatus } from "../store/billingStore";

export function getModelBillingState(
  model: AIModel,
  billingStatus: BillingStatus | null,
) {
  const isFreeModel = model.tier === "free";
  const isProModel = model.tier === "pro";
  const billingEnabled = billingStatus?.billingEnabled ?? false;
  const isFreePlan = billingEnabled && billingStatus?.plan === "free";
  const isRestricted = isProModel && isFreePlan;

  return {
    isFreeModel,
    isProModel,
    billingEnabled,
    isFreePlan,
    isRestricted,
  };
}
