import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import type {
  NotificationDeliveryApi,
  NotificationResourceTypeApi,
  NotificationRuleApi,
} from "../lib/api-types";

function resourceKey(
  resourceType: NotificationResourceTypeApi,
  resourceId: string,
): string {
  return `${resourceType}:${resourceId}`;
}

interface NotificationRuleState {
  rulesByKey: Record<string, NotificationRuleApi[]>;
  deliveriesByKey: Record<string, NotificationDeliveryApi[]>;
}

interface NotificationRuleActions {
  fetchRules: (
    workspaceId: string,
    resourceType: NotificationResourceTypeApi,
    resourceId: string,
  ) => Promise<NotificationRuleApi[]>;
  fetchDeliveries: (
    workspaceId: string,
    resourceType: NotificationResourceTypeApi,
    resourceId: string,
    options?: { limit?: number; skipCache?: boolean },
  ) => Promise<NotificationDeliveryApi[]>;
  createRule: (
    workspaceId: string,
    body: Record<string, unknown>,
  ) => Promise<{ rule: NotificationRuleApi; signingSecretOnce?: string }>;
  updateRule: (
    workspaceId: string,
    ruleId: string,
    body: Record<string, unknown>,
  ) => Promise<{ rule: NotificationRuleApi; signingSecretOnce?: string }>;
  deleteRule: (workspaceId: string, ruleId: string) => Promise<void>;
  testNotification: (
    workspaceId: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
  clearCacheForResource: (
    resourceType: NotificationResourceTypeApi,
    resourceId: string,
  ) => void;
}

export const useNotificationRuleStore = create<
  NotificationRuleState & NotificationRuleActions
>()(
  immer((set, _get) => ({
    rulesByKey: {},
    deliveriesByKey: {},

    fetchRules: async (workspaceId, resourceType, resourceId) => {
      const key = resourceKey(resourceType, resourceId);
      const res = await apiClient.get<{
        success: boolean;
        rules: NotificationRuleApi[];
      }>(`/workspaces/${workspaceId}/notification-rules`, {
        resourceType,
        resourceId,
      });
      set(s => {
        s.rulesByKey[key] = res.rules || [];
      });
      return res.rules || [];
    },

    fetchDeliveries: async (workspaceId, resourceType, resourceId, options) => {
      const key = resourceKey(resourceType, resourceId);
      const params: Record<string, string> = {
        resourceType,
        resourceId,
      };
      if (options?.limit != null) {
        params.limit = String(options.limit);
      }
      const res = await apiClient.get<{
        success: boolean;
        deliveries: NotificationDeliveryApi[];
      }>(`/workspaces/${workspaceId}/notification-rules/deliveries`, params);
      const list = res.deliveries || [];
      if (!options?.skipCache) {
        set(s => {
          s.deliveriesByKey[key] = list;
        });
      }
      return list;
    },

    createRule: async (workspaceId, body) => {
      const res = await apiClient.post<{
        success: boolean;
        rule: NotificationRuleApi;
        signingSecretOnce?: string;
      }>(`/workspaces/${workspaceId}/notification-rules`, body);
      const rt = res.rule.resourceType;
      const rid = res.rule.resourceId;
      const key = resourceKey(rt, rid);
      set(s => {
        const list = s.rulesByKey[key] || [];
        s.rulesByKey[key] = [...list, res.rule];
      });
      return { rule: res.rule, signingSecretOnce: res.signingSecretOnce };
    },

    updateRule: async (workspaceId, ruleId, body) => {
      const res = await apiClient.patch<{
        success: boolean;
        rule: NotificationRuleApi;
        signingSecretOnce?: string;
      }>(`/workspaces/${workspaceId}/notification-rules/${ruleId}`, body);
      const rt = res.rule.resourceType;
      const rid = res.rule.resourceId;
      const key = resourceKey(rt, rid);
      set(s => {
        const list = s.rulesByKey[key] || [];
        s.rulesByKey[key] = list.map(r => (r.id === ruleId ? res.rule : r));
      });
      return { rule: res.rule, signingSecretOnce: res.signingSecretOnce };
    },

    deleteRule: async (workspaceId, ruleId) => {
      await apiClient.delete(
        `/workspaces/${workspaceId}/notification-rules/${ruleId}`,
      );
      set(s => {
        for (const k of Object.keys(s.rulesByKey)) {
          s.rulesByKey[k] = s.rulesByKey[k].filter(r => r.id !== ruleId);
        }
      });
    },

    testNotification: async (workspaceId, body) => {
      await apiClient.post(
        `/workspaces/${workspaceId}/notification-rules/test`,
        body,
      );
    },

    clearCacheForResource: (resourceType, resourceId) => {
      const key = resourceKey(resourceType, resourceId);
      set(s => {
        delete s.rulesByKey[key];
        delete s.deliveriesByKey[key];
      });
    },
  })),
);

export function ruleSummary(rule: NotificationRuleApi): string {
  const ch = rule.channel;
  if (ch.type === "email") return ch.recipients.join(", ");
  if (ch.type === "webhook") return ch.urlPreview || "Webhook";
  return ch.displayLabel || "Slack";
}
