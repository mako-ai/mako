/**
 * Billing Store
 *
 * Manages billing status, checkout, and portal sessions.
 * All billing API calls are centralized here per project conventions.
 */

import { create } from "zustand";
import { apiClient } from "../lib/api-client";

export interface BillingStatus {
  billingEnabled: boolean;
  plan: "free" | "pro" | "enterprise";
  subscriptionStatus: string | null;
  currentUsageUsd: number;
  usageQuotaUsd: number;
  hardLimitUsd: number | null;
  invocationCount: number;
  totalTokens: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  hasStripeCustomer: boolean;
  hasSubscription: boolean;
}

interface BillingState {
  status: BillingStatus | null;
  isLoading: boolean;
  error: string | null;

  fetchBillingStatus: (workspaceId: string) => Promise<void>;
  createCheckoutSession: (
    workspaceId: string,
    successUrl?: string,
    cancelUrl?: string,
  ) => Promise<string | null>;
  createPortalSession: (
    workspaceId: string,
    returnUrl?: string,
  ) => Promise<string | null>;
  reset: () => void;
}

export const useBillingStore = create<BillingState>()(set => ({
  status: null,
  isLoading: false,
  error: null,

  fetchBillingStatus: async (workspaceId: string) => {
    set({ isLoading: true, error: null });
    try {
      const data = await apiClient.get<BillingStatus>(
        `/workspaces/${workspaceId}/billing/status`,
      );
      set({ status: data, isLoading: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : "Failed to fetch billing status",
        isLoading: false,
      });
    }
  },

  createCheckoutSession: async (
    workspaceId: string,
    successUrl?: string,
    cancelUrl?: string,
  ) => {
    set({ error: null });
    try {
      const result = await apiClient.post<{ url: string }>(
        `/workspaces/${workspaceId}/billing/checkout`,
        { successUrl, cancelUrl },
      );
      return result.url;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to create checkout",
      });
      return null;
    }
  },

  createPortalSession: async (workspaceId: string, returnUrl?: string) => {
    set({ error: null });
    try {
      const result = await apiClient.post<{ url: string }>(
        `/workspaces/${workspaceId}/billing/portal`,
        { returnUrl },
      );
      return result.url;
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : "Failed to create portal session",
      });
      return null;
    }
  },

  reset: () => set({ status: null, isLoading: false, error: null }),
}));
