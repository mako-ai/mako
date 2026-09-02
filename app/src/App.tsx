import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  type CSSProperties,
} from "react";
import {
  Box,
  CircularProgress,
  styled,
  BottomNavigation,
  BottomNavigationAction,
  Paper,
} from "@mui/material";
import {
  MessageCircleMore as AskTabIcon,
  Eye as ViewTabIcon,
  Compass as BrowseTabIcon,
} from "lucide-react";
import {
  Routes,
  Route,
  useParams,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { trackEvent, trackPageView } from "./lib/analytics";
import { setIframeDragGuard } from "./lib/iframe-drag-guard";
import Sidebar from "./components/Sidebar";
import MobileBrowse from "./components/MobileBrowse";
import { useRecentsStore } from "./store/recentsStore";
import { useIsMobile } from "./hooks/useIsMobile";
import {
  CENTER_PANE_MIN_WIDTH_PX,
  DEFAULT_LEFT_PANE_WIDTH_PX,
  DEFAULT_RIGHT_PANE_WIDTH_PX,
  SIDE_PANEL_MAX_WIDTH_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  useUIStore,
} from "./store/uiStore";
import { useConsoleStore } from "./store/consoleStore";
import { useExplorerRevealStore } from "./store/explorerRevealStore";
import { tabRevealTarget } from "./lib/explorer-reveal";
import { consoleLeafName } from "./lib/console-name";
import Chat from "./components/Chat";
import DatabaseExplorer, {
  type CollectionInfo,
} from "./components/DatabaseExplorer";
import ConsoleExplorer from "./components/ConsoleExplorer";
import DataSourceExplorer from "./components/ConnectorExplorer";
import Editor from "./components/Editor";
import DbtProjectDrawersHost from "./components/DbtProjectDrawersHost";
import { FlowsExplorer } from "./components/FlowsExplorer";
import SettingsExplorer from "./components/SettingsExplorer";
const loadDashboardsExplorer = () => import("./components/DashboardsExplorer");
const DashboardsExplorer = lazy(loadDashboardsExplorer);
const loadNotebooksExplorer = () => import("./components/NotebooksExplorer");
const NotebooksExplorer = lazy(loadNotebooksExplorer);
const loadAppsExplorer = () => import("./components/AppsExplorer");
const AppsExplorer = lazy(loadAppsExplorer);
const SourceControlExplorer = lazy(
  () => import("./components/SourceControlExplorer"),
);
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));
const loadDbtExplorer = () => import("./components/DbtExplorer");
const DbtExplorer = lazy(loadDbtExplorer);
import { AuthWrapper } from "./components/AuthWrapper";
import { AcceptInvite } from "./components/AcceptInvite";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { OnboardingProvider } from "./contexts/onboarding-context";
import type { DbFlowFormRef } from "./components/DbFlowForm";
import { generateObjectId } from "./utils/objectId";
import { readReturnTo, takeReturnTo } from "./utils/return-to";
import { LoginPage } from "./components/LoginPage";
import { DesktopAuthPage } from "./components/DesktopAuthPage";
import { hasPendingDesktopAuth } from "./utils/desktop-auth-redirect";
import { RegisterPage } from "./components/RegisterPage";
import { VerifyEmailPage } from "./components/VerifyEmailPage";
import { ForgotPasswordPage } from "./components/ForgotPasswordPage";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { useAuth } from "./contexts/auth-context";
import { OnboardingFlow } from "./components/OnboardingFlow";
import { UpdateNotification } from "./components/UpdateNotification";

// Draggable divider between a side pane and the flexible center. A real
// react-resizable-panels handle so it participates in the library's global
// handle registry: where it crosses a perpendicular handle (the editor/results
// split), hovering shows the four-arrow "move" cursor and dragging resizes
// both panes at once.
const SideResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  flex: "0 0 4px",
  width: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  touchAction: "none",
  transition: "background-color 0.2s ease",
  // The library flags hover/drag via a data attribute (it extends beyond the
  // 4px strip through hit-area margins), so key the highlight off that.
  "&[data-resize-handle-state='hover'], &[data-resize-handle-state='drag']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

// Collapse a divider entirely while its side pane is closed.
const HIDDEN_HANDLE_STYLE: CSSProperties = {
  flex: "0 0 0px",
  width: 0,
  minWidth: 0,
  opacity: 0,
  pointerEvents: "none",
};

// Component for the invite page route
function InvitePage() {
  const { token } = useParams<{ token: string }>();

  if (!token) {
    return <div>Invalid invitation link</div>;
  }

  return (
    <WorkspaceProvider>
      <AcceptInvite token={token} />
    </WorkspaceProvider>
  );
}

import { UrlSync } from "./components/UrlSync";
import CommandPalette from "./components/CommandPalette";

// Main application component (extracted from original App)

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function MainApp() {
  const activeView = useUIStore(state => state.leftPane);
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const tabFocusSeq = useConsoleStore(state => state.tabFocusSeq);
  const requestReveal = useExplorerRevealStore(state => state.requestReveal);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const closeLeftPane = useUIStore(state => state.closeLeftPane);
  const openRightPane = useUIStore(state => state.openRightPane);
  const closeRightPane = useUIStore(state => state.closeRightPane);
  const leftPaneWidthPx = useUIStore(state => state.leftPaneWidthPx);
  const rightPaneWidthPx = useUIStore(state => state.rightPaneWidthPx);
  const setPaneWidths = useUIStore(state => state.setPaneWidths);

  // Mobile (< md) shell state. Desktop ignores these entirely.
  const isMobile = useIsMobile();
  const mobileTab = useUIStore(state => state.mobileTab);
  const setMobileTab = useUIStore(state => state.setMobileTab);

  // On mobile, tapping a tree node in Browse opens/focuses a tab. Surface it
  // in View so the result of the tap is visible. Keyed on the focus counter,
  // not the active id: re-tapping the node that is already selected changes
  // nothing about the active tab but must still open View. Gated on Browse
  // being the active tab so chat-driven tab opens (e.g. the agent creating a
  // console) don't yank the user out of Ask mid-conversation.
  useEffect(() => {
    if (!isMobile) return;
    if (!useConsoleStore.getState().activeTabId) return;
    if (useUIStore.getState().mobileTab !== "browse") return;
    setMobileTab("view");
  }, [tabFocusSeq, isMobile, setMobileTab]);

  // Recents (the Browse tab's list): every activation of a durable, reopenable
  // tab is recorded locally. Recorded on every device, read on phones.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = useConsoleStore.getState().tabs[activeTabId];
    const workspaceId = useUIStore.getState().currentWorkspaceId;
    if (!tab || !workspaceId) return;
    const kind = tab.kind ?? "console";
    const record = useRecentsStore.getState().record;
    if (kind === "console") {
      record(workspaceId, { kind, id: tab.id, title: tab.title });
    } else if (kind === "dashboard" && tab.metadata?.dashboardId) {
      record(workspaceId, {
        kind,
        id: tab.metadata.dashboardId as string,
        title: tab.title,
      });
    } else if (kind === "notebook" && tab.metadata?.notebookId) {
      record(workspaceId, {
        kind,
        id: tab.metadata.notebookId as string,
        title: tab.title,
      });
    } else if (kind === "app" && tab.metadata?.appId) {
      record(workspaceId, {
        kind,
        id: tab.metadata.appId as string,
        title: tab.title,
        slug: tab.metadata.appSlug as string | undefined,
      });
    }
  }, [activeTabId]);

  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);

  // Side panes have a FIXED pixel width. Only the center pane flexes to fill
  // the remaining space, so resizing the window never changes the side panes —
  // it only grows/shrinks the center (Slack/Cursor behavior). react-resizable-
  // panels is percentage-based, so we keep the source of truth in px (refs +
  // the UI store) and translate: px → % when (re)applying layout, % → px when
  // the user drags a handle.
  const leftWidthRef = useRef(
    leftPaneWidthPx && leftPaneWidthPx > 0
      ? clamp(leftPaneWidthPx, SIDE_PANEL_MIN_WIDTH_PX, SIDE_PANEL_MAX_WIDTH_PX)
      : DEFAULT_LEFT_PANE_WIDTH_PX,
  );
  const rightWidthRef = useRef(
    rightPaneWidthPx && rightPaneWidthPx > 0
      ? clamp(
          rightPaneWidthPx,
          SIDE_PANEL_MIN_WIDTH_PX,
          SIDE_PANEL_MAX_WIDTH_PX,
        )
      : DEFAULT_RIGHT_PANE_WIDTH_PX,
  );

  // Container width drives all px↔% conversions. Seeded with an estimate so
  // the first paint is close; the ResizeObserver below corrects it.
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === "undefined" ? 1200 : Math.max(window.innerWidth - 52, 1),
  );
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;

  const openFlagsRef = useRef({ left: leftPaneOpen, right: rightPaneOpen });
  openFlagsRef.current = { left: leftPaneOpen, right: rightPaneOpen };

  // Compute the full [left, center, right] percentage layout from the px
  // widths, honoring closed (collapsed to 0) panes.
  const computeLayoutPct = useCallback((width: number): number[] => {
    const { left, right } = openFlagsRef.current;
    const leftPct = left ? (leftWidthRef.current / width) * 100 : 0;
    const rightPct = right ? (rightWidthRef.current / width) * 100 : 0;
    return [leftPct, Math.max(100 - leftPct - rightPct, 0), rightPct];
  }, []);

  // Keep side panes at their fixed px width when the container resizes: the
  // library would otherwise scale all panels proportionally. A callback ref
  // (rather than a mount effect) attaches the observer, because AuthWrapper
  // gates the children — the container div doesn't exist on first commit.
  const containerObserverRef = useRef<ResizeObserver | null>(null);
  const attachPanelContainer = useCallback((el: HTMLDivElement | null) => {
    panelContainerRef.current = el;
    containerObserverRef.current?.disconnect();
    containerObserverRef.current = null;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setContainerWidth(width);
    });
    observer.observe(el);
    containerObserverRef.current = observer;
  }, []);
  // Re-apply the px-derived layout after the width state commits, so the
  // min/max percentage constraints derived from it are already up to date.
  useLayoutEffect(() => {
    if (containerWidth <= 0) return;
    groupRef.current?.setLayout(computeLayoutPct(containerWidth));
  }, [containerWidth, computeLayoutPct]);

  // Persist px widths (debounced) as the user drags a handle.
  const persistTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (persistTimeoutRef.current) {
        window.clearTimeout(persistTimeoutRef.current);
      }
    };
  }, []);
  const handleGroupLayout = useCallback(
    (sizes: number[]) => {
      const width = containerWidthRef.current;
      if (width <= 0 || sizes.length !== 3) return;
      const [leftPct, , rightPct] = sizes;
      if (leftPct > 0) leftWidthRef.current = (leftPct * width) / 100;
      if (rightPct > 0) rightWidthRef.current = (rightPct * width) / 100;

      if (persistTimeoutRef.current) {
        window.clearTimeout(persistTimeoutRef.current);
      }
      persistTimeoutRef.current = window.setTimeout(() => {
        const updates: {
          leftPaneWidthPx?: number;
          rightPaneWidthPx?: number;
        } = {};
        if (leftPct > 0) updates.leftPaneWidthPx = leftWidthRef.current;
        if (rightPct > 0) updates.rightPaneWidthPx = rightWidthRef.current;
        if (Object.keys(updates).length > 0) {
          setPaneWidths(updates);
        }
      }, 200);
    },
    [setPaneWidths],
  );

  // Re-apply the layout when the open flags change elsewhere (sidebar
  // toggles, chat close button, ...): computeLayoutPct collapses closed panes
  // to 0 and restores open ones to their remembered px width. Dragging a pane
  // below the collapse threshold collapses it via the library, which flips
  // the flag through onCollapse and keeps both in sync.
  useEffect(() => {
    groupRef.current?.setLayout(
      computeLayoutPct(Math.max(containerWidthRef.current, 1)),
    );
  }, [leftPaneOpen, rightPaneOpen, computeLayoutPct]);

  // While dragging, make iframes (e.g. the app preview) transparent to
  // pointer events so they don't swallow the drag mid-flight. Also snapshot
  // the pane widths so a drag-to-collapse can restore the pre-drag width
  // (dragging past the minimum would otherwise leave the remembered width at
  // the minimum, and the pane would reopen tiny).
  const dragSnapshotRef = useRef<{ left: number; right: number } | null>(null);
  const snapshotClearTimeoutRef = useRef<number | null>(null);
  const handleDividerDragging = useCallback((isDragging: boolean) => {
    setIframeDragGuard(isDragging);
    if (snapshotClearTimeoutRef.current) {
      window.clearTimeout(snapshotClearTimeoutRef.current);
      snapshotClearTimeoutRef.current = null;
    }
    if (isDragging) {
      dragSnapshotRef.current = {
        left: leftWidthRef.current,
        right: rightWidthRef.current,
      };
    } else {
      // Clear on the next macrotask: the panel onCollapse callback fires from
      // a React effect that may commit *after* the pointerup, and it needs
      // the snapshot to restore the pre-drag width.
      snapshotClearTimeoutRef.current = window.setTimeout(() => {
        dragSnapshotRef.current = null;
        snapshotClearTimeoutRef.current = null;
      }, 0);
    }
  }, []);

  const handleLeftCollapse = useCallback(() => {
    const snapshot = dragSnapshotRef.current;
    if (snapshot) leftWidthRef.current = snapshot.left;
    closeLeftPane();
  }, [closeLeftPane]);
  const handleRightCollapse = useCallback(() => {
    const snapshot = dragSnapshotRef.current;
    if (snapshot) rightWidthRef.current = snapshot.right;
    closeRightPane();
  }, [closeRightPane]);

  // px-based panel constraints expressed as percentages of the container.
  const sideMinPct = (SIDE_PANEL_MIN_WIDTH_PX / containerWidth) * 100;
  const sideMaxPct = (SIDE_PANEL_MAX_WIDTH_PX / containerWidth) * 100;
  const centerMinPct = (CENTER_PANE_MIN_WIDTH_PX / containerWidth) * 100;
  const defaultLayout = computeLayoutPct(containerWidth);

  // Ref for DbFlowForm - allows AI agent to manipulate form state
  const dbFlowFormRef = useRef<DbFlowFormRef | null>(null);

  // Ref for chart spec changes - allows AI agent to set chart specs on the active console tab
  const onChartSpecChangeRef = useRef<
    | ((payload: import("./components/Editor").ChartSpecChangePayload) => void)
    | undefined
  >(undefined);

  // Ref for results context - allows Chat to read current results/chart state at request time
  const resultsContextRef = useRef<
    import("./components/Editor").ConsoleResultsContext | null
  >(null);

  // NOTE: console modifications from the agent no longer flow through App —
  // console tools execute server-side (issue #475) and open tabs follow
  // along via the realtime channel (realtimeStore).

  const openOrFocusConsoleTab = useCallback(
    (
      title: string,
      content: string,
      connectionId?: string, // DatabaseConnection ID (renamed from databaseId)
      filePath?: string,
      consoleId?: string, // Add optional consoleId parameter
      isPlaceholder?: boolean,
      queryOptions?: Record<string, any>, // Options to pass when executing (e.g., D1 databaseId)
      explicitDatabaseId?: string, // Explicit database ID (e.g., D1 UUID from saved console)
      explicitDatabaseName?: string, // Explicit database name from saved console
    ) => {
      // For existing consoles, use the server ID as the tab ID
      const tabId = consoleId || generateObjectId();

      const { tabs, setActiveTab, openTab, updateContent } =
        useConsoleStore.getState();
      const consoleTabs = Object.values(tabs);

      // Check if a tab with this ID already exists
      const existing = consoleTabs.find(t => t.id === tabId);

      if (existing) {
        // Tab already exists, just focus it
        setActiveTab(existing.id);
        // Never replace an already-open console with placeholder content while
        // the background fetch is in flight. The eventual fetch update is guarded
        // by no-op store writes, so repeated explorer clicks stay cheap.
        if (!isPlaceholder && existing.content !== content) {
          updateContent(existing.id, content);
        }
        return;
      }

      // Use explicit values if provided, otherwise extract from queryOptions (tree node metadata)
      // databaseId: used for selector value, saving to DB, and API calls (UUID for D1, name for MongoDB/PostgreSQL)
      // databaseName: used for display in selector (human-readable name, falls back to databaseId)
      const databaseId =
        explicitDatabaseId ||
        queryOptions?.databaseId ||
        queryOptions?.databaseName;
      const databaseName =
        explicitDatabaseName || queryOptions?.databaseName || databaseId;

      // Create a new tab with the determined ID
      // If consoleId is provided, this is an existing saved console from the database
      // Set isSaved=true to prevent auto-save (especially important for placeholder content)
      const isExistingSavedConsole = !!consoleId;
      const id = openTab({
        id: tabId, // Pass the ID explicitly
        title,
        content,
        connectionId,
        databaseId, // D1 database UUID or other DB-specific ID
        databaseName, // Human-readable database name
        // If placeholder, defer setting filePath so savedStateHash isn't computed
        filePath: isPlaceholder ? undefined : filePath,
        // Mark as saved if this is an existing console to prevent auto-save of placeholder content
        isSaved: isExistingSavedConsole,
        // Store query execution options for backward compatibility
        metadata: queryOptions ? { queryOptions } : undefined,
      });
      setActiveTab(id);
    },
    [],
  );

  const handleDatabaseCollectionClick = useCallback(
    async (dbId: string, collection: CollectionInfo) => {
      // Try server-provided template first
      let prefill = `db.getCollection("${collection.name}").find({}).limit(500)`;
      try {
        const { useSchemaStore } = await import("./store/schemaStore");
        const workspaceId = localStorage.getItem("activeWorkspaceId");
        if (workspaceId) {
          const tpl = await useSchemaStore
            .getState()
            .fetchConsoleTemplate(workspaceId, dbId, {
              id: collection.name,
              kind: collection.type || "collection",
              metadata: collection.options as Record<string, unknown>,
            });
          if (tpl?.template) prefill = tpl.template;
        }
      } catch {
        // Server template unavailable; keep the collection default prefill.
        // (SQL tables open a paginated data tab instead of a console now.)
      }
      openOrFocusConsoleTab(
        collection.name,
        prefill,
        dbId, // connectionId
        undefined, // filePath
        undefined, // consoleId
        undefined, // isPlaceholder
        collection.options as Record<string, unknown> | undefined, // queryOptions - contains D1 databaseName (UUID), MongoDB dbName, etc.
      );
    },
    [openOrFocusConsoleTab],
  );

  const handleConsoleSelect = useCallback(
    (
      path: string,
      content: string,
      connectionId?: string,
      consoleId?: string,
      isPlaceholder?: boolean,
      databaseId?: string,
      databaseName?: string,
    ) => {
      openOrFocusConsoleTab(
        // Title is the LEAF name (canonical display name); the full path is
        // kept as filePath for the breadcrumb folder trail + deep link.
        consoleLeafName(path),
        content,
        connectionId,
        path,
        consoleId,
        isPlaceholder,
        undefined, // queryOptions - not needed for saved consoles
        databaseId,
        databaseName,
      );
    },
    [openOrFocusConsoleTab],
  );

  // When the focused tab changes, scroll the sidebar explorer to its row —
  // but only when that explorer is already the one on screen. If the user is
  // looking at a different explorer (or the pane is collapsed), leave it as is.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = useConsoleStore.getState().tabs[activeTabId];
    const target = tabRevealTarget(tab);
    if (!target) return;
    const { leftPane, leftPaneOpen: paneOpen } = useUIStore.getState();
    if (paneOpen && leftPane === target.explorer) {
      requestReveal(target.explorer, target.nodeId);
    }
  }, [activeTabId, requestReveal]);

  // Left pane content. Memoized (like the editor/chat elements below) so
  // PanelGroup re-renders during a divider drag reuse the same element and
  // React bails out of re-rendering the heavy explorer subtree.
  const leftPaneContent = useMemo(() => {
    switch (activeView) {
      case "databases":
        return (
          <DatabaseExplorer onCollectionClick={handleDatabaseCollectionClick} />
        );
      case "consoles":
        return <ConsoleExplorer onConsoleSelect={handleConsoleSelect} />;
      case "connectors":
        return <DataSourceExplorer />;
      case "flows":
        return <FlowsExplorer />;
      case "dashboards":
        return <DashboardsExplorer />;
      case "apps":
        return <AppsExplorer />;
      case "notebooks":
        return <NotebooksExplorer />;
      case "source-control":
        return <SourceControlExplorer />;
      case "dbt":
        return <DbtExplorer />;
      case "settings":
        return <SettingsExplorer />;
      default:
        return null;
    }
  }, [activeView, handleDatabaseCollectionClick, handleConsoleSelect]);

  // Stable elements for the heavy center/right panes. All props are refs, so
  // these never need to be re-created; identical element references let React
  // skip re-rendering Editor/Chat on every layout change while dragging.
  const editorElement = useMemo(
    () => (
      <Editor
        dbFlowFormRef={dbFlowFormRef}
        onChartSpecChangeRef={onChartSpecChangeRef}
        resultsContextRef={resultsContextRef}
      />
    ),
    [],
  );
  const chatElement = useMemo(
    () => (
      <Chat
        dbFlowFormRef={dbFlowFormRef}
        onChartSpecChangeRef={onChartSpecChangeRef}
        resultsContextRef={resultsContextRef}
      />
    ),
    [],
  );

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    let idleId: number | undefined;
    let timeoutId: number | undefined;

    if (typeof win.requestIdleCallback === "function") {
      idleId = win.requestIdleCallback(() => {
        void loadDashboardsExplorer();
      });
    } else {
      timeoutId = window.setTimeout(() => {
        void loadDashboardsExplorer();
      }, 1500);
    }

    return () => {
      if (
        idleId !== undefined &&
        typeof win.cancelIdleCallback === "function"
      ) {
        win.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  // ── Mobile shell (< md) ───────────────────────────────────────────────
  // One full-screen pane at a time behind a FIXED bottom nav — Browse ·
  // View · Ask, the desktop pane order. All three stay mounted (visibility
  // toggled) so their state survives tab switches, mirroring the desktop
  // multi-pane mount. Per-kind switches live inside View (see Editor).
  if (isMobile) {
    return (
      <AuthWrapper>
        <UrlSync />
        <CommandPalette />
        <Box
          data-mako-app-shell="true"
          data-mako-mobile="true"
          sx={{
            display: "flex",
            flexDirection: "column",
            height: "100dvh",
            width: "100vw",
            maxWidth: "100vw",
            overflow: "hidden",
            // No top app bar on mobile — navigation is the bottom nav. Keep
            // content clear of the status bar / notch on standalone installs.
            pt: "env(safe-area-inset-top)",
          }}
        >
          {/* Content — one pane at a time, all kept mounted for state */}
          <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
            {/* Browse: search, recents and the explorers, as a pane. */}
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: mobileTab === "browse" ? "block" : "none",
              }}
            >
              <MobileBrowse
                explorer={
                  <Suspense
                    fallback={
                      <Box
                        sx={{
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <CircularProgress size={20} />
                      </Box>
                    }
                  >
                    {leftPaneContent}
                  </Suspense>
                }
              />
            </Box>
            {/* View: the active tab (console, app, dashboard, ...). */}
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: mobileTab === "view" ? "block" : "none",
              }}
            >
              {editorElement}
            </Box>
            {/* Ask: chat. */}
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: mobileTab === "ask" ? "block" : "none",
              }}
            >
              {chatElement}
            </Box>
          </Box>

          {/* Bottom navigation — fixed: Browse · View · Ask. */}
          <Paper
            square
            elevation={3}
            sx={{
              borderTop: 1,
              borderColor: "divider",
              pb: "env(safe-area-inset-bottom)",
            }}
          >
            <BottomNavigation
              showLabels
              value={mobileTab}
              onChange={(_event, value) =>
                setMobileTab(value as "browse" | "view" | "ask")
              }
            >
              <BottomNavigationAction
                label="Browse"
                value="browse"
                icon={<BrowseTabIcon size={22} strokeWidth={1.5} />}
              />
              <BottomNavigationAction
                label="View"
                value="view"
                icon={<ViewTabIcon size={22} strokeWidth={1.5} />}
              />
              <BottomNavigationAction
                label="Ask"
                value="ask"
                icon={<AskTabIcon size={22} strokeWidth={1.5} />}
              />
            </BottomNavigation>
          </Paper>
        </Box>
        <DbtProjectDrawersHost />
      </AuthWrapper>
    );
  }

  return (
    <AuthWrapper>
      <UrlSync />
      <CommandPalette />
      <Box
        data-mako-app-shell="true"
        sx={{
          display: "flex",
          height: "100vh",
          width: "100vw",
          maxWidth: "100vw",
          overflow: "hidden",
        }}
      >
        {/* Sidebar Navigation */}
        <Sidebar />

        <Box
          ref={attachPanelContainer}
          sx={{ height: "100%", flex: 1, minWidth: 0 }}
        >
          <PanelGroup
            ref={groupRef}
            direction="horizontal"
            style={{ height: "100%", width: "100%" }}
            onLayout={handleGroupLayout}
          >
            {/* Left side pane — fixed pixel width, resizable by hand */}
            <Panel
              id="left-pane"
              order={1}
              collapsible
              collapsedSize={0}
              defaultSize={leftPaneOpen ? defaultLayout[0] : 0}
              minSize={sideMinPct}
              maxSize={sideMaxPct}
              onCollapse={handleLeftCollapse}
              onExpand={openLeftPane}
            >
              <Box sx={{ height: "100%", overflow: "hidden" }}>
                <Suspense
                  fallback={
                    <Box
                      sx={{
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <CircularProgress size={20} />
                    </Box>
                  }
                >
                  {leftPaneContent}
                </Suspense>
              </Box>
            </Panel>

            <SideResizeHandle
              onDragging={handleDividerDragging}
              style={leftPaneOpen ? undefined : HIDDEN_HANDLE_STYLE}
            />

            {/* Center (main content) — flexes to fill remaining space */}
            <Panel id="center-pane" order={2} minSize={centerMinPct}>
              <Box
                data-mako-main-content="true"
                sx={{ height: "100%", minWidth: 0 }}
              >
                {editorElement}
              </Box>
            </Panel>

            <SideResizeHandle
              onDragging={handleDividerDragging}
              style={rightPaneOpen ? undefined : HIDDEN_HANDLE_STYLE}
            />

            {/* Right side pane (chat) — fixed pixel width, resizable by hand */}
            <Panel
              id="right-pane"
              order={3}
              collapsible
              collapsedSize={0}
              defaultSize={rightPaneOpen ? defaultLayout[2] : 0}
              minSize={sideMinPct}
              maxSize={sideMaxPct}
              onCollapse={handleRightCollapse}
              onExpand={openRightPane}
            >
              <Box
                sx={{
                  height: "100%",
                  overflow: "hidden",
                  borderLeft: "1px solid",
                  borderColor: "divider",
                }}
              >
                {chatElement}
              </Box>
            </Panel>
          </PanelGroup>
        </Box>
      </Box>
      <DbtProjectDrawersHost />
    </AuthWrapper>
  );
}

// Loading spinner component
function LoadingScreen() {
  return (
    <Box
      display="flex"
      justifyContent="center"
      alignItems="center"
      minHeight="100vh"
    >
      <CircularProgress size={60} />
    </Box>
  );
}

/**
 * Same-origin post-login destination, e.g. the MCP OAuth consent page
 * (/api/oauth/mcp/authorize?...) sends users here with ?returnTo=<path>.
 * Only relative paths are honored so the parameter can't redirect off-site.
 */
function safeReturnTo(): string | null {
  // ?returnTo on this URL, or the one stashed before an OAuth round trip
  // (utils/return-to.ts) — the API's login gate sets the parameter.
  return readReturnTo() ?? takeReturnTo();
}

// Auth route wrapper - redirects to "/" if already authenticated
function AuthRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  // If already authenticated, resume a pending desktop sign-in handoff,
  // honor a same-origin returnTo (OAuth consent), or go to the main app
  if (user) {
    if (hasPendingDesktopAuth()) {
      return <Navigate to="/desktop-auth" replace />;
    }
    const returnTo = safeReturnTo();
    if (returnTo) {
      // Full navigation: the target may be an API-served page, not a route.
      window.location.replace(returnTo);
      return <LoadingScreen />;
    }
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

// Login page with navigation to register and forgot password
function LoginRoute() {
  const navigate = useNavigate();
  return (
    <AuthRoute>
      <LoginPage
        onSwitchToRegister={() => navigate("/register")}
        onForgotPassword={() => navigate("/forgot-password")}
      />
    </AuthRoute>
  );
}

// Forgot password page
function ForgotPasswordRoute() {
  const navigate = useNavigate();
  return (
    <AuthRoute>
      <ForgotPasswordPage onBackToLogin={() => navigate("/login")} />
    </AuthRoute>
  );
}

// Reset password page - accessed via email link
function ResetPasswordRoute() {
  return <ResetPasswordPage />;
}

// Register page with navigation to login
function RegisterRoute() {
  const navigate = useNavigate();
  return (
    <AuthRoute>
      <RegisterPage onSwitchToLogin={() => navigate("/login")} />
    </AuthRoute>
  );
}

// Verify email page - no auth redirect (user may need to verify before being logged in)
function VerifyEmailRoute() {
  return <VerifyEmailPage />;
}

// Onboarding test route - allows testing onboarding flow independently
// Accessible at /onboarding for manual testing without needing to clear user state
function OnboardingTestRoute() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) {
    return <LoadingScreen />;
  }

  // Require authentication to test onboarding
  if (!user) {
    return (
      <Navigate
        to="/login"
        state={{ from: { pathname: "/onboarding" } }}
        replace
      />
    );
  }

  const handleComplete = () => {
    // After completing test onboarding, navigate to main app
    navigate("/", { replace: true });
  };

  return (
    <OnboardingProvider>
      <WorkspaceProvider>
        <OnboardingFlow onComplete={handleComplete} />
      </WorkspaceProvider>
    </OnboardingProvider>
  );
}

// Resume a pending Mako Desktop sign-in handoff after the user authenticates
// in the browser (any method — including the full-page OAuth round trip,
// which lands back on "/"). The challenge is stashed in sessionStorage by
// DesktopAuthPage before redirecting to /login.
function DesktopAuthResume() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading || !user) return null;
  if (location.pathname === "/desktop-auth") return null;
  if (!hasPendingDesktopAuth()) return null;

  return <Navigate to="/desktop-auth" replace />;
}

// Fire checkout_completed exactly once when Stripe redirects back with
// ?billing=success (see api billing route's default successUrl). The param is
// stripped via replaceState so refreshes/back-navigation don't re-fire it.
function CheckoutSuccessTracker() {
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("billing") !== "success") return;

    trackEvent("checkout_completed");

    params.delete("billing");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
  }, [location.search, location.pathname, location.hash]);

  return null;
}

// Track page views on route changes for SPA
function PageViewTracker() {
  const location = useLocation();

  useEffect(() => {
    // Defer tracking to allow child components to update document.title first.
    // Child components (like Editor) set the title in their own useEffect hooks,
    // which run after this effect. Using requestAnimationFrame + setTimeout
    // ensures we capture the title after React's render cycle completes.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const rafId = requestAnimationFrame(() => {
      timeoutId = setTimeout(() => {
        trackPageView(location.pathname, document.title);
      }, 0);
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [location.pathname]);

  return null;
}

function App() {
  return (
    <>
      <PageViewTracker />
      <CheckoutSuccessTracker />
      <DesktopAuthResume />
      <UpdateNotification />
      <Routes>
        {/* Invite route - no authentication required */}
        <Route path="/invite/:token" element={<InvitePage />} />

        {/* Public share viewer - no authentication required. The optional
            first segment is the workspace slug (cosmetic only). */}
        {["/share/:token", "/share/:workspaceSlug/:token"].map(path => (
          <Route
            key={path}
            path={path}
            element={
              <Suspense
                fallback={
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      height: "100vh",
                    }}
                  >
                    <CircularProgress />
                  </Box>
                }
              >
                <PublicSharePage />
              </Suspense>
            }
          />
        ))}

        {/* Desktop sign-in handoff - renders for both authed and unauthed users */}
        <Route path="/desktop-auth" element={<DesktopAuthPage />} />

        {/* Auth routes - redirect to "/" if already logged in */}
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/register" element={<RegisterRoute />} />
        <Route path="/verify-email" element={<VerifyEmailRoute />} />
        <Route path="/forgot-password" element={<ForgotPasswordRoute />} />
        <Route path="/reset-password" element={<ResetPasswordRoute />} />

        {/* Onboarding test route - for manual testing */}
        <Route path="/onboarding" element={<OnboardingTestRoute />} />

        {/* Main app route - authentication required */}
        <Route path="/*" element={<MainApp />} />
      </Routes>
    </>
  );
}

export default App;
