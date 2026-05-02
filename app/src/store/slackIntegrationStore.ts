import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface SlackConnectionApi {
  id: string;
  workspaceId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  scopes: string[];
  installedByUserId: string;
  installedAt: string;
}

export interface SlackChannelApi {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface SlackIntegrationState {
  connectionByWorkspace: Record<string, SlackConnectionApi | null | undefined>;
  channelsByWorkspace: Record<string, SlackChannelApi[] | undefined>;
}

interface SlackIntegrationActions {
  fetchConnection: (workspaceId: string) => Promise<SlackConnectionApi | null>;
  disconnectSlack: (workspaceId: string) => Promise<void>;
  fetchChannels: (workspaceId: string) => Promise<SlackChannelApi[]>;
  exchangeWebhookToken: (
    workspaceId: string,
    token: string,
  ) => Promise<{ slackWebhookUrl: string; displayLabel: string }>;
  clearWorkspaceCache: (workspaceId: string) => void;
}

export const useSlackIntegrationStore = create<
  SlackIntegrationState & SlackIntegrationActions
>()(
  immer(set => ({
    connectionByWorkspace: {},
    channelsByWorkspace: {},

    fetchConnection: async workspaceId => {
      try {
        const res = await apiClient.get<{
          success: boolean;
          connection: SlackConnectionApi;
        }>(`/workspaces/${workspaceId}/slack/connection`);
        set(s => {
          s.connectionByWorkspace[workspaceId] = res.connection;
        });
        return res.connection;
      } catch {
        set(s => {
          s.connectionByWorkspace[workspaceId] = null;
        });
        return null;
      }
    },

    disconnectSlack: async workspaceId => {
      await apiClient.delete(`/workspaces/${workspaceId}/slack/connection`);
      set(s => {
        s.connectionByWorkspace[workspaceId] = null;
        delete s.channelsByWorkspace[workspaceId];
      });
    },

    fetchChannels: async workspaceId => {
      const res = await apiClient.get<{
        success: boolean;
        channels: SlackChannelApi[];
      }>(`/workspaces/${workspaceId}/slack/channels`);
      const list = res.channels || [];
      set(s => {
        s.channelsByWorkspace[workspaceId] = list;
      });
      return list;
    },

    exchangeWebhookToken: async (workspaceId, token) => {
      const res = await apiClient.post<{
        success: boolean;
        slackWebhookUrl: string;
        displayLabel: string;
      }>(`/workspaces/${workspaceId}/slack/exchange-webhook-token`, {
        token,
      });
      return {
        slackWebhookUrl: res.slackWebhookUrl,
        displayLabel: res.displayLabel,
      };
    },

    clearWorkspaceCache: workspaceId => {
      set(s => {
        delete s.connectionByWorkspace[workspaceId];
        delete s.channelsByWorkspace[workspaceId];
      });
    },
  })),
);
