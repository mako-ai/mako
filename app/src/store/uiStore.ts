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
export const DEFAULT_RIGHT_PANE_SIZE = 20;
export const SIDE_PANEL_MIN_DEFAULT_WIDTH_PX = 150;
export const SIDE_PANEL_MAX_DEFAULT_WIDTH_PX = 300;
export const SIDE_PANEL_COLLAPSE_THRESHOLD_PX = 120;

// Fixed pixel widths for the side panes. The side panes keep a constant pixel
// width (Slack/Cursor style) and only the center pane flexes with the window.
export const DEFAULT_LEFT_PANE_WIDTH_PX = 260;
export const DEFAULT_RIGHT_PANE_WIDTH_PX = 360;
// Hard limits for manual drag-resizing of a side pane.
export const SIDE_PANEL_MIN_WIDTH_PX = 150;
export const SIDE_PANEL_MAX_WIDTH_PX = 600;
// Keep the center (main content) pane at least this wide when resizing a side.
export const CENTER_PANE_MIN_WIDTH_PX = 320;

interface ActiveEditorContent {
  content: string;
  fileName?: string;
  language?: string;
}

/**
 * Which full-screen pane is shown on mobile (< md). Desktop ignores this and
 * keeps its 4-column flex shell. "explore" is surfaced via the explorer Drawer
 * rather than a dedicated content pane (see `setMobileTab`).
 */
export type MobileTab = "ask" | "editor" | "results" | "explore";

/** Mobile overlay drawer state. Only the explorer drawer exists today. */
export type MobileDrawer = "none" | "explorer";

interface UIState {
  // Navigation
  leftPane: LeftPaneView;
  activeView: LeftPaneView; // Legacy alias for leftPane
  leftPaneOpen: boolean;
  rightPaneOpen: boolean;
  leftPaneWidthPx: number | null;
  rightPaneWidthPx: number | null;

  // Mobile (< md) navigation — ephemeral, never persisted. Desktop layout is
  // driven by leftPaneOpen/rightPaneOpen; mobile is driven by mobileTab.
  mobileTab: MobileTab;
  mobileDrawer: MobileDrawer;

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
  setRightPaneOpen: (open: boolean) => void;
  openRightPane: () => void;
  closeRightPane: () => void;
  setPaneWidths: (widths: {
    leftPaneWidthPx?: number | null;
    rightPaneWidthPx?: number | null;
  }) => void;

  // Mobile navigation
  setMobileTab: (tab: MobileTab) => void;
  openMobileDrawer: () => void;
  closeMobileDrawer: () => void;

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
  rightPaneOpen: true,
  leftPaneWidthPx: null,
  rightPaneWidthPx: null,
  mobileTab: "ask",
  mobileDrawer: "none",
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

      setRightPaneOpen: open =>
        set(state => {
          state.rightPaneOpen = open;
        }),

      openRightPane: () =>
        set(state => {
          state.rightPaneOpen = true;
        }),

      closeRightPane: () =>
        set(state => {
          state.rightPaneOpen = false;
        }),

      setPaneWidths: widths =>
        set(state => {
          if (widths.leftPaneWidthPx !== undefined) {
            state.leftPaneWidthPx = widths.leftPaneWidthPx;
          }
          if (widths.rightPaneWidthPx !== undefined) {
            state.rightPaneWidthPx = widths.rightPaneWidthPx;
          }
        }),

      // Mobile navigation. Selecting "explore" opens the explorer Drawer as an
      // overlay rather than swapping the underlying content pane, so closing
      // the drawer returns to the previous ask/editor/results view.
      setMobileTab: tab =>
        set(state => {
          if (tab === "explore") {
            state.mobileDrawer = "explorer";
          } else {
            state.mobileTab = tab;
            state.mobileDrawer = "none";
          }
        }),

      openMobileDrawer: () =>
        set(state => {
          state.mobileDrawer = "explorer";
        }),

      closeMobileDrawer: () =>
        set(state => {
          state.mobileDrawer = "none";
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
        rightPaneOpen: state.rightPaneOpen,
        leftPaneWidthPx: state.leftPaneWidthPx,
        rightPaneWidthPx: state.rightPaneWidthPx,
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

/**
 * The "active explorer" — the explorer panel currently visible on the left,
 * or `null` when no explorer is open (pane collapsed). Unlike `leftPane`,
 * which is the last-selected view and is retained across collapse/expand
 * so it can be restored, `activeExplorer` reflects what is *actually* on
 * screen. Consumers (sidebar highlight, AI context, etc.) should prefer
 * this over `leftPane` when they want to know what the user is looking at.
 */
export type ActiveExplorer =
  | "databases"
  | "consoles"
  | "connectors"
  | "flows"
  | "dashboards"
  | "apps"
  | "dbt"
  | "settings"
  | null;

const EXPLORER_VIEWS: ReadonlySet<LeftPaneView> = new Set([
  "databases",
  "consoles",
  "connectors",
  "flows",
  "dashboards",
  "apps",
  "dbt",
  "settings",
]);

export const selectActiveExplorer = (state: UIStore): ActiveExplorer =>
  state.leftPaneOpen && EXPLORER_VIEWS.has(state.leftPane)
    ? (state.leftPane as Exclude<ActiveExplorer, null>)
    : null;
