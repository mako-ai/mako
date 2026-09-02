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
 * keeps its 4-column flex shell. The bottom nav is FIXED — Browse · View ·
 * Ask, the same left-to-right order as the desktop panes (explorer, editor,
 * chat) — so what a tab means never depends on what is open. Per-kind
 * switches (a console's query/results, an app's preview/terminal) live inside
 * the View pane, beside the window pill, not in the nav.
 */
export type MobileTab = "browse" | "view" | "ask";

/** Which half of a console tab the mobile View pane shows. */
export type MobileConsolePane = "query" | "results";

/** Which half of an app tab in dev mode the mobile View pane shows. */
export type MobileAppPane = "preview" | "terminal";

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
  mobileConsolePane: MobileConsolePane;
  mobileAppPane: MobileAppPane;

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
  setMobileConsolePane: (pane: MobileConsolePane) => void;
  setMobileAppPane: (pane: MobileAppPane) => void;

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
  mobileConsolePane: "query",
  mobileAppPane: "preview",
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

      // Mobile navigation — plain setters; the nav is fixed and nothing here
      // is persisted (see partialize), so a reload lands on Ask.
      setMobileTab: tab =>
        set(state => {
          state.mobileTab = tab;
        }),

      setMobileConsolePane: pane =>
        set(state => {
          state.mobileConsolePane = pane;
        }),

      setMobileAppPane: pane =>
        set(state => {
          state.mobileAppPane = pane;
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
      // Pre-rename persisted pane selections ("apps-v2") land on the Apps
      // explorer instead of falling through to the default pane.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIStore>;
        if ((p.leftPane as string) === "apps-v2") p.leftPane = "apps";
        return { ...current, ...p };
      },
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
 * Imperative read of the current workspace id for code that runs outside
 * React (agent client tools, tab-open shells). Components should subscribe
 * with `selectCurrentWorkspaceId` instead.
 */
export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

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
  | "notebooks"
  | "dbt"
  | "source-control"
  | "settings"
  | null;

// Every LeftPaneView that renders an explorer — which today is every view.
// This list has silently drifted from the union before (notebooks and
// source-control were both missing, so their rail icons never highlighted);
// keep it in lockstep with LeftPaneView when adding a view.
const EXPLORER_VIEWS: ReadonlySet<LeftPaneView> = new Set([
  "databases",
  "consoles",
  "connectors",
  "flows",
  "dashboards",
  "apps",
  "notebooks",
  "dbt",
  "source-control",
  "settings",
]);

export const selectActiveExplorer = (state: UIStore): ActiveExplorer =>
  state.leftPaneOpen && EXPLORER_VIEWS.has(state.leftPane)
    ? (state.leftPane as Exclude<ActiveExplorer, null>)
    : null;
