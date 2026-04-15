/**
 * Billing Configuration
 *
 * Plan definitions, feature flag, and model tier mapping.
 * When BILLING_ENABLED is false (default), all billing checks are bypassed,
 * giving self-hosted / open-source users unlimited access.
 */

import { isFreeTierModel } from "../services/model-catalog.service";

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
    usageQuotaUsd: 5,
    hardLimitUsd: 5,
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

export async function getModelTier(modelId: string): Promise<ModelTier> {
  return (await isFreeTierModel(modelId)) ? "free" : "pro";
}

export async function isModelAvailableForPlan(
  modelId: string,
  plan: BillingPlan,
): Promise<boolean> {
  const modelTier = await getModelTier(modelId);
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
