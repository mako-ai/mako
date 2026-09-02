import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";

export interface SourceConnectionDraft {
  tabId: string;
  values: Record<string, any>;
  isDirty: boolean;
}

interface SourceConnectionState {
  drafts: Record<string, SourceConnectionDraft>;
  /**
   * Upsert (create or update) the draft for the given tab.
   */
  upsertDraft: (tabId: string, values: Record<string, any>) => void;
  /**
   * Remove the draft associated with the given tab.
   */
  deleteDraft: (tabId: string) => void;
  /**
   * Remove every stored draft (used during logout, etc.).
   */
  clearDrafts: () => void;
}

export const useSourceConnectionStore = create<SourceConnectionState>()(
  persist(
    immer(set => ({
      drafts: {},
      upsertDraft: (tabId, values) =>
        set(state => {
          state.drafts[tabId] = {
            tabId,
            values,
            isDirty: true,
          };
        }),
      deleteDraft: tabId =>
        set(state => {
          delete state.drafts[tabId];
        }),
      clearDrafts: () =>
        set(state => {
          state.drafts = {};
        }),
    })),
    {
      name: "connector-draft-store",
      version: 1,
    },
  ),
);

/** @deprecated use useSourceConnectionStore */
export const useConnectorStore = useSourceConnectionStore;
