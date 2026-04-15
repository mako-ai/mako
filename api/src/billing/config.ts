/**
 * Billing Configuration
 *
 * Plan definitions, feature flag, and model tier mapping.
 * When BILLING_ENABLED is false (default), all billing checks are bypassed,
 * giving self-hosted / open-source users unlimited access.
 */

import { ALL_MODELS } from "../agent-lib/ai-models";

export function isBillingEnabled(): boolean {
  return process.env.BILLING_ENABLED === "true";
}

export type BillingPlan = "free" | "pro" | "enterprise";

export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "trialing"
  | "incomplete"
  | null;

export type ModelTier = "free" | "pro";

export interface PlanDefinition {
  name: string;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  modelTier: ModelTier;
  maxDatabases: number;
  maxMembers: number;
}

export const PLAN_DEFINITIONS: Record<BillingPlan, PlanDefinition> = {
  free: {
    name: "Free",
    usageQuotaUsd: 0.5,
    hardLimitUsd: 0.5,
    modelTier: "free",
    maxDatabases: 3,
    maxMembers: 3,
  },
  pro: {
    name: "Pro",
    usageQuotaUsd: 80,
    hardLimitUsd: null,
    modelTier: "pro",
    maxDatabases: 50,
    maxMembers: 25,
  },
  enterprise: {
    name: "Enterprise",
    usageQuotaUsd: 100,
    hardLimitUsd: null,
    modelTier: "pro",
    maxDatabases: 999,
    maxMembers: 999,
  },
};

/**
 * Map model IDs to billing tiers, derived from ALL_MODELS to avoid
 * maintaining a duplicate mapping that can silently diverge.
 * Unknown models default to "pro" in getModelTier().
 */
const MODEL_TIER_MAP: Record<string, ModelTier> = Object.fromEntries(
  ALL_MODELS.map(m => [m.id, m.tier]),
);

export function getModelTier(modelId: string): ModelTier {
  return MODEL_TIER_MAP[modelId] ?? "pro";
}

export function isModelAvailableForPlan(
  modelId: string,
  plan: BillingPlan,
): boolean {
  const modelTier = getModelTier(modelId);
  if (modelTier === "free") return true;
  return plan !== "free";
}

export function getStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return key;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return secret;
}

export function getStripeProPriceId(): string {
  const id = process.env.STRIPE_PRO_PRICE_ID;
  if (!id) throw new Error("STRIPE_PRO_PRICE_ID is not configured");
  return id;
}

export function getStripeOveragePriceId(): string {
  const id = process.env.STRIPE_OVERAGE_PRICE_ID;
  if (!id) throw new Error("STRIPE_OVERAGE_PRICE_ID is not configured");
  return id;
}

export function getStripeMeterEventName(): string {
  return process.env.STRIPE_METER_EVENT_NAME || "llm_usage_usd";
}
