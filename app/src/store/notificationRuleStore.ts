import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";
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
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/notification-rules", {
          params: {
            path: { workspaceId },
            query: { resourceType, resourceId },
          },
        }),
      ) as { rules?: NotificationRuleApi[] };
      set(s => {
        s.rulesByKey[key] = res.rules || [];
      });
      return res.rules || [];
    },

    fetchDeliveries: async (workspaceId, resourceType, resourceId, options) => {
      const key = resourceKey(resourceType, resourceId);
      const res = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/notification-rules/deliveries",
          {
            params: {
              path: { workspaceId },
              query: {
                resourceType,
                resourceId,
                ...(options?.limit != null
                  ? { limit: String(options.limit) }
                  : {}),
              },
            },
          },
        ),
      ) as { deliveries?: NotificationDeliveryApi[] };
      const list = res.deliveries || [];
      if (!options?.skipCache) {
        set(s => {
          s.deliveriesByKey[key] = list;
        });
      }
      return list;
    },

    createRule: async (workspaceId, body) => {
      const res = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/notification-rules", {
          params: { path: { workspaceId } },
          body,
        }),
      ) as { rule: NotificationRuleApi; signingSecretOnce?: string };
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
      const res = unwrapBody(
        await api.PATCH(
          "/api/workspaces/{workspaceId}/notification-rules/{ruleId}",
          { params: { path: { workspaceId, ruleId } }, body },
        ),
      ) as { rule: NotificationRuleApi; signingSecretOnce?: string };
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
      unwrapBody(
        await api.DELETE(
          "/api/workspaces/{workspaceId}/notification-rules/{ruleId}",
          { params: { path: { workspaceId, ruleId } } },
        ),
      );
      set(s => {
        for (const k of Object.keys(s.rulesByKey)) {
          s.rulesByKey[k] = s.rulesByKey[k].filter(r => r.id !== ruleId);
        }
      });
    },

    testNotification: async (workspaceId, body) => {
      unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/notification-rules/test",
          { params: { path: { workspaceId } }, body },
        ),
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
