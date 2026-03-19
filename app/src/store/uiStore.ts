/**
 * UI Store
 *
 * Manages client-only UI state like navigation, loading indicators,
 * and ephemeral UI state. No API calls - purely synchronous state.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { LeftPaneView } from "./lib/types";

export const DEFAULT_LEFT_PANE_SIZE = 15;

interface ActiveEditorContent {
  content: string;
  fileName?: string;
  language?: string;
}

interface UIState {
  // Navigation
  leftPane: LeftPaneView;
  activeView: LeftPaneView; // Legacy alias for leftPane
  leftPaneOpen: boolean;

  // Loading indicators (keyed by operation name)
  loading: Record<string, boolean>;

  // Active editor content (ephemeral, not persisted)
  activeEditorContent?: ActiveEditorContent;

  // Current workspace
  currentWorkspaceId: string | null;
}

interface UIActions {
  // Navigation
  setLeftPane: (pane: LeftPaneView) => void;
  navigateToView: (view: LeftPaneView) => void;
  setLeftPaneOpen: (open: boolean) => void;
  openLeftPane: () => void;
  closeLeftPane: () => void;

  // Loading state
  setLoading: (key: string, value: boolean) => void;
  isLoading: (key: string) => boolean;

  // Editor content
  setActiveEditorContent: (content: ActiveEditorContent | undefined) => void;

  // Workspace
  setCurrentWorkspaceId: (workspaceId: string | null) => void;

  // Reset
  reset: () => void;
}

type UIStore = UIState & UIActions;

const initialState: UIState = {
  leftPane: "databases",
  activeView: "databases",
  leftPaneOpen: true,
  loading: {},
  activeEditorContent: undefined,
  currentWorkspaceId: null,
};

export const useUIStore = create<UIStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      // Navigation
      setLeftPane: pane =>
        set(state => {
          state.leftPane = pane;
          state.activeView = pane; // Keep in sync
        }),

      navigateToView: view =>
        set(state => {
          state.leftPane = view;
          state.activeView = view;
        }),

      setLeftPaneOpen: open =>
        set(state => {
          state.leftPaneOpen = open;
        }),

      openLeftPane: () =>
        set(state => {
          state.leftPaneOpen = true;
        }),

      closeLeftPane: () =>
        set(state => {
          state.leftPaneOpen = false;
        }),

      // Loading state
      setLoading: (key, value) =>
        set(state => {
          if (value) {
            state.loading[key] = true;
          } else {
            delete state.loading[key];
          }
        }),

      isLoading: key => !!get().loading[key],

      // Editor content
      setActiveEditorContent: content =>
        set(state => {
          state.activeEditorContent = content;
        }),

      // Workspace
      setCurrentWorkspaceId: workspaceId =>
        set(state => {
          state.currentWorkspaceId = workspaceId;
        }),

      // Reset
      reset: () => set(initialState),
    })),
    {
      name: "ui-store",
      // Only persist navigation and workspace - not loading states or editor content
      partialize: state => ({
        leftPane: state.leftPane,
        activeView: state.activeView,
        leftPaneOpen: state.leftPaneOpen,
        currentWorkspaceId: state.currentWorkspaceId,
      }),
    },
  ),
);

// Selectors for common patterns
export const selectLeftPane = (state: UIStore) => state.leftPane;
export const selectCurrentWorkspaceId = (state: UIStore) =>
  state.currentWorkspaceId;
export const selectActiveEditorContent = (state: UIStore) =>
  state.activeEditorContent;
