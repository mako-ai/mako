import { describe, expect, it } from "vitest";
import { getModelBillingState } from "./model-selector-utils";

describe("getModelBillingState", () => {
  it("restricts pro-tier models for free workspaces when billing is enabled", () => {
    const result = getModelBillingState(
      {
        id: "anthropic/claude-opus-4-6",
        name: "Opus",
        provider: "anthropic",
        tier: "pro",
      },
      {
        billingEnabled: true,
        plan: "free",
        subscriptionStatus: null,
        currentUsageUsd: 0,
        usageQuotaUsd: 5,
        hardLimitUsd: 5,
        invocationCount: 0,
        totalTokens: 0,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        hasStripeCustomer: false,
        hasSubscription: false,
      },
    );

    expect(result.isRestricted).toBe(true);
  });

  it("does not mislabel models with an unknown tier as restricted", () => {
    const result = getModelBillingState(
      { id: "custom/model", name: "Custom", provider: "custom" },
      {
        billingEnabled: true,
        plan: "free",
        subscriptionStatus: null,
        currentUsageUsd: 0,
        usageQuotaUsd: 5,
        hardLimitUsd: 5,
        invocationCount: 0,
        totalTokens: 0,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        hasStripeCustomer: false,
        hasSubscription: false,
      },
    );

    expect(result.isProModel).toBe(false);
    expect(result.isRestricted).toBe(false);
  });
});
