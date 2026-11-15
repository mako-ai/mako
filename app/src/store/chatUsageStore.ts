/**
 * Chat Usage Store
 *
 * Cumulative token + cost per chat session, keyed by chat id.
 *
 * Two writers, and the asymmetry between them is the whole design:
 *  - `seedSessionUsage` REPLACES, and is called whenever a chat's persisted
 *    payload is loaded. The server's running totals are authoritative.
 *  - `addTurnUsage` ACCUMULATES, and is called once per finished live turn so
 *    the number moves without a refetch.
 *
 * Because a load replaces rather than adds, re-loading a chat after a live turn
 * cannot double count. Keying by chat id is what keeps two open sessions from
 * bleeding into each other.
 */

import { create } from "zustand";

import { api } from "../api/client";
import {
  addUsage,
  EMPTY_SESSION_USAGE,
  type SessionUsage,
} from "../components/chat/session-usage";

interface ChatUsageState {
  byChatId: Record<string, SessionUsage>;
  /** Replace a chat's totals from the persisted payload. */
  seedSessionUsage: (chatId: string, totals: SessionUsage) => void;
  /** Add one finished turn's delta on top of what is already there. */
  addTurnUsage: (chatId: string, delta: SessionUsage) => void;
  clearSessionUsage: (chatId: string) => void;
  /** The server's authoritative per-chat aggregate (undefined if none). */
  fetchChatTotals: (
    workspaceId: string,
    chatId: string,
  ) => Promise<ChatUsageTotals | undefined>;
}

export interface ChatUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export const useChatUsageStore = create<ChatUsageState>()((set, get) => ({
  byChatId: {},

  fetchChatTotals: async (workspaceId, chatId) => {
    const { data } = await api.GET(
      "/api/workspaces/{workspaceId}/usage/by-chat/{chatId}",
      { params: { path: { workspaceId, chatId } } },
    );
    return data?.totals;
  },

  seedSessionUsage: (chatId, totals) => {
    if (!chatId) return;
    set(state => ({ byChatId: { ...state.byChatId, [chatId]: totals } }));
  },

  addTurnUsage: (chatId, delta) => {
    if (!chatId) return;
    const current = get().byChatId[chatId] ?? EMPTY_SESSION_USAGE;
    set(state => ({
      byChatId: { ...state.byChatId, [chatId]: addUsage(current, delta) },
    }));
  },

  clearSessionUsage: chatId => {
    if (!chatId) return;
    set(state => {
      if (!(chatId in state.byChatId)) return state;
      const next = { ...state.byChatId };
      delete next[chatId];
      return { byChatId: next };
    });
  },
}));

/** Read totals outside React (callbacks, refs) without subscribing. */
export function getSessionUsage(chatId: string): SessionUsage {
  return useChatUsageStore.getState().byChatId[chatId] ?? EMPTY_SESSION_USAGE;
}
