/**
 * Billing Store
 *
 * Manages billing status, checkout, and portal sessions.
 * All billing API calls are centralized here per project conventions.
 */

import { create } from "zustand";
import { api, unwrapBody } from "../api";
import { trackEvent } from "../lib/analytics";

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
  workspaceId: string | null;
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
  workspaceId: null,
  status: null,
  isLoading: false,
  error: null,

  fetchBillingStatus: async (workspaceId: string) => {
    set(state => ({
      workspaceId,
      status: state.workspaceId === workspaceId ? state.status : null,
      isLoading: true,
      error: null,
    }));
    try {
      const data = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/billing/status", {
          params: { path: { workspaceId } },
        }),
      ) as BillingStatus;
      set({ workspaceId, status: data, isLoading: false });
    } catch (err) {
      set({
        workspaceId,
        status: null,
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
      const result = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/billing/checkout", {
          params: { path: { workspaceId } },
          body: { successUrl, cancelUrl },
        }),
      ) as { url: string };
      // Marketing funnel event: the user is being handed to Stripe Checkout.
      trackEvent("checkout_started", { workspace_id: workspaceId });
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
      const result = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/billing/portal", {
          params: { path: { workspaceId } },
          body: { returnUrl },
        }),
      ) as { url: string };
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

  reset: () =>
    set({ workspaceId: null, status: null, isLoading: false, error: null }),
}));
