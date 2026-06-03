import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
} from "react";
import { Box, CircularProgress, styled } from "@mui/material";
import {
  Routes,
  Route,
  useParams,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { trackPageView } from "./lib/analytics";
import Sidebar from "./components/Sidebar";
import {
  DEFAULT_LEFT_PANE_SIZE,
  DEFAULT_RIGHT_PANE_SIZE,
  SIDE_PANEL_COLLAPSE_THRESHOLD_PX,
  SIDE_PANEL_MAX_DEFAULT_WIDTH_PX,
  SIDE_PANEL_MIN_DEFAULT_WIDTH_PX,
  useUIStore,
} from "./store/uiStore";
import { useConsoleStore } from "./store/consoleStore";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import Chat from "./components/Chat";
import DatabaseExplorer, {
  type CollectionInfo,
} from "./components/DatabaseExplorer";
import ConsoleExplorer from "./components/ConsoleExplorer";
import DataSourceExplorer from "./components/ConnectorExplorer";
import Editor from "./components/Editor";
import { FlowsExplorer } from "./components/FlowsExplorer";
import SettingsExplorer from "./components/SettingsExplorer";
const loadDashboardsExplorer = () => import("./components/DashboardsExplorer");
const DashboardsExplorer = lazy(loadDashboardsExplorer);
import { AuthWrapper } from "./components/AuthWrapper";
import { AcceptInvite } from "./components/AcceptInvite";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { OnboardingProvider } from "./contexts/onboarding-context";
import { ConsoleModificationPayload } from "./hooks/useMonacoConsole";
import type { DbFlowFormRef } from "./components/DbFlowForm";
import { generateObjectId } from "./utils/objectId";
import { LoginPage } from "./components/LoginPage";
import { RegisterPage } from "./components/RegisterPage";
import { VerifyEmailPage } from "./components/VerifyEmailPage";
import { ForgotPasswordPage } from "./components/ForgotPasswordPage";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { useAuth } from "./contexts/auth-context";
import { OnboardingFlow } from "./components/OnboardingFlow";

// Styled PanelResizeHandle components (moved from Databases.tsx/Consoles.tsx)
const StyledHorizontalResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  width: "4px",
  background: theme.palette.divider,
  cursor: "col-resize",
  transition: "background-color 0.2s ease",
  "&:hover": {
    backgroundColor: theme.palette.primary.main,
  },
}));

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

// Main application component (extracted from original App)
const EDITOR_PANEL_MIN_SIZE = 30;
type ResizeHandleSide = "left" | "right";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pxToPanelPercent(
  px: number,
  containerWidth: number,
  fallbackPct: number,
): number {
  return containerWidth > 0 ? (px / containerWidth) * 100 : fallbackPct;
}

function calculateFixedPanelLayout({
  containerWidth,
  leftPaneOpen,
  rightPaneOpen,
  targetLeftPx,
  targetRightPx,
}: {
  containerWidth: number;
  leftPaneOpen: boolean;
  rightPaneOpen: boolean;
  targetLeftPx: number;
  targetRightPx: number;
}): [number, number, number] {
  const sideBudgetPct = Math.max(0, 100 - EDITOR_PANEL_MIN_SIZE);
  const minSidePct =
    containerWidth > 0
      ? (SIDE_PANEL_COLLAPSE_THRESHOLD_PX / containerWidth) * 100
      : 0;
  const minLeftPct = leftPaneOpen ? minSidePct : 0;
  const minRightPct = rightPaneOpen ? minSidePct : 0;

  let leftPct = leftPaneOpen
    ? pxToPanelPercent(targetLeftPx, containerWidth, DEFAULT_LEFT_PANE_SIZE)
    : 0;
  let rightPct = rightPaneOpen
    ? pxToPanelPercent(targetRightPx, containerWidth, DEFAULT_RIGHT_PANE_SIZE)
    : 0;

  if (minLeftPct + minRightPct <= sideBudgetPct) {
    leftPct = Math.max(leftPct, minLeftPct);
    rightPct = Math.max(rightPct, minRightPct);

    const overflowPct = leftPct + rightPct - sideBudgetPct;
    if (overflowPct > 0) {
      const leftShrinkCapacity = leftPct - minLeftPct;
      const rightShrinkCapacity = rightPct - minRightPct;
      const totalShrinkCapacity = leftShrinkCapacity + rightShrinkCapacity;

      if (totalShrinkCapacity > 0) {
        leftPct -= overflowPct * (leftShrinkCapacity / totalShrinkCapacity);
        rightPct -= overflowPct * (rightShrinkCapacity / totalShrinkCapacity);
      }
    }
  } else {
    const totalSidePct = leftPct + rightPct;
    const scale =
      totalSidePct > sideBudgetPct && totalSidePct > 0
        ? sideBudgetPct / totalSidePct
        : 1;

    leftPct *= scale;
    rightPct *= scale;
  }

  return [leftPct, Math.max(0, 100 - leftPct - rightPct), rightPct];
}

function MainApp() {
  const activeView = useUIStore(state => state.leftPane);
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const setLeftPaneOpen = useUIStore(state => state.setLeftPaneOpen);
  const setRightPaneOpen = useUIStore(state => state.setRightPaneOpen);
  const leftPaneWidthPx = useUIStore(state => state.leftPaneWidthPx);
  const rightPaneWidthPx = useUIStore(state => state.rightPaneWidthPx);
  const setPaneWidths = useUIStore(state => state.setPaneWidths);

  const leftPaneRef = useRef<ImperativePanelHandle | null>(null);
  const rightPaneRef = useRef<ImperativePanelHandle | null>(null);
  const panelGroupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const isHandleDraggingRef = useRef(false);
  const activeResizeHandleRef = useRef<ResizeHandleSide | null>(null);
  const frozenDefaultLeftPxRef = useRef<number | null>(null);
  const frozenDefaultRightPxRef = useRef<number | null>(null);

  // Initialize with window width to avoid 0 width on first render
  const [panelContainerWidth, setPanelContainerWidth] = useState(() =>
    typeof window === "undefined" ? 1000 : window.innerWidth - 52,
  );

  // Keep container width updated
  useEffect(() => {
    const el = panelContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const newWidth = entries[0].contentRect.width;
      if (newWidth > 0) {
        setPanelContainerWidth(newWidth);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (panelContainerWidth > 0 && frozenDefaultLeftPxRef.current === null) {
    frozenDefaultLeftPxRef.current = clamp(
      (panelContainerWidth * DEFAULT_LEFT_PANE_SIZE) / 100,
      SIDE_PANEL_MIN_DEFAULT_WIDTH_PX,
      SIDE_PANEL_MAX_DEFAULT_WIDTH_PX,
    );
  }

  if (panelContainerWidth > 0 && frozenDefaultRightPxRef.current === null) {
    frozenDefaultRightPxRef.current = clamp(
      (panelContainerWidth * DEFAULT_RIGHT_PANE_SIZE) / 100,
      SIDE_PANEL_MIN_DEFAULT_WIDTH_PX,
      SIDE_PANEL_MAX_DEFAULT_WIDTH_PX,
    );
  }

  const defaultLeftPx =
    frozenDefaultLeftPxRef.current ?? SIDE_PANEL_MIN_DEFAULT_WIDTH_PX;
  const defaultRightPx =
    frozenDefaultRightPxRef.current ?? SIDE_PANEL_MIN_DEFAULT_WIDTH_PX;

  const targetLeftPx =
    leftPaneWidthPx && leftPaneWidthPx > 0 ? leftPaneWidthPx : defaultLeftPx;
  const targetRightPx =
    rightPaneWidthPx && rightPaneWidthPx > 0
      ? rightPaneWidthPx
      : defaultRightPx;

  const fixedPanelLayout = useMemo(
    () =>
      calculateFixedPanelLayout({
        containerWidth: panelContainerWidth,
        leftPaneOpen,
        rightPaneOpen,
        targetLeftPx,
        targetRightPx,
      }),
    [
      leftPaneOpen,
      panelContainerWidth,
      rightPaneOpen,
      targetLeftPx,
      targetRightPx,
    ],
  );
  const [leftSizePct, , rightSizePct] = fixedPanelLayout;

  // Threshold for collapsing
  const collapseThresholdPct =
    panelContainerWidth > 0
      ? (SIDE_PANEL_COLLAPSE_THRESHOLD_PX / panelContainerWidth) * 100
      : 0;

  const applyFixedSidePanelLayout = useCallback(() => {
    if (panelContainerWidth <= 0 || isHandleDraggingRef.current) return;

    panelGroupRef.current?.setLayout(fixedPanelLayout);
  }, [fixedPanelLayout, panelContainerWidth]);

  useEffect(() => {
    applyFixedSidePanelLayout();
  }, [applyFixedSidePanelLayout]);

  const persistTimeoutRef = useRef<number | null>(null);
  const persistPanelWidths = useCallback(
    (sizes: number[], handleSide: ResizeHandleSide) => {
      if (panelContainerWidth <= 0) return;

      const [leftPct, , rightPct] = sizes;
      const updates: { leftPaneWidthPx?: number; rightPaneWidthPx?: number } =
        {};

      if (handleSide === "left" && leftPct > 0) {
        updates.leftPaneWidthPx = (leftPct * panelContainerWidth) / 100;
      }
      if (handleSide === "right" && rightPct > 0) {
        updates.rightPaneWidthPx = (rightPct * panelContainerWidth) / 100;
      }

      if (Object.keys(updates).length > 0) {
        setPaneWidths(updates);
      }
    },
    [panelContainerWidth, setPaneWidths],
  );

  const persistPanelWidthFromHandle = useCallback(
    (handleSide: ResizeHandleSide) => {
      if (panelContainerWidth <= 0) return;

      const updates: { leftPaneWidthPx?: number; rightPaneWidthPx?: number } =
        {};
      const leftPanel = leftPaneRef.current;
      const rightPanel = rightPaneRef.current;

      if (handleSide === "left" && leftPanel && !leftPanel.isCollapsed()) {
        updates.leftPaneWidthPx =
          (leftPanel.getSize() * panelContainerWidth) / 100;
      }
      if (handleSide === "right" && rightPanel && !rightPanel.isCollapsed()) {
        updates.rightPaneWidthPx =
          (rightPanel.getSize() * panelContainerWidth) / 100;
      }

      if (Object.keys(updates).length > 0) {
        setPaneWidths(updates);
      }
    },
    [panelContainerWidth, setPaneWidths],
  );

  // Handle layout changes from manual drag only. Container resizes should keep
  // stored side widths fixed and let the center editor absorb the delta.
  const handleLayout = useCallback(
    (sizes: number[]) => {
      const handleSide = activeResizeHandleRef.current;
      if (
        !isHandleDraggingRef.current ||
        !handleSide ||
        panelContainerWidth <= 0
      ) {
        return;
      }

      if (persistTimeoutRef.current) {
        clearTimeout(persistTimeoutRef.current);
      }

      persistTimeoutRef.current = window.setTimeout(() => {
        persistPanelWidths(sizes, handleSide);
      }, 200);
    },
    [panelContainerWidth, persistPanelWidths],
  );

  const handlePanelDragging = useCallback(
    (handleSide: ResizeHandleSide, isDragging: boolean) => {
      isHandleDraggingRef.current = isDragging;

      if (isDragging) {
        activeResizeHandleRef.current = handleSide;
        return;
      }

      const activeHandleSide = activeResizeHandleRef.current ?? handleSide;
      activeResizeHandleRef.current = null;

      if (persistTimeoutRef.current) {
        clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = null;
      }
      persistPanelWidthFromHandle(activeHandleSide);
    },
    [persistPanelWidthFromHandle],
  );

  const handleLeftPanelDragging = useCallback(
    (isDragging: boolean) => handlePanelDragging("left", isDragging),
    [handlePanelDragging],
  );

  const handleRightPanelDragging = useCallback(
    (isDragging: boolean) => handlePanelDragging("right", isDragging),
    [handlePanelDragging],
  );

  useEffect(
    () => () => {
      if (persistTimeoutRef.current) {
        clearTimeout(persistTimeoutRef.current);
      }
    },
    [],
  );

  // Handle external open/close for Left Pane
  const prevLeftOpen = useRef(leftPaneOpen);
  useEffect(() => {
    if (leftPaneOpen && !prevLeftOpen.current) {
      const panel = leftPaneRef.current;
      if (panel && panel.isCollapsed()) {
        panel.expand();
        panel.resize(
          pxToPanelPercent(
            targetLeftPx,
            panelContainerWidth,
            DEFAULT_LEFT_PANE_SIZE,
          ),
        );
      }
    } else if (!leftPaneOpen && prevLeftOpen.current) {
      const panel = leftPaneRef.current;
      if (panel && !panel.isCollapsed()) {
        panel.collapse();
      }
    }
    prevLeftOpen.current = leftPaneOpen;
  }, [leftPaneOpen, panelContainerWidth, targetLeftPx]);

  // Handle external open/close for Right Pane
  const prevRightOpen = useRef(rightPaneOpen);
  useEffect(() => {
    if (rightPaneOpen && !prevRightOpen.current) {
      const panel = rightPaneRef.current;
      if (panel && panel.isCollapsed()) {
        panel.expand();
        panel.resize(
          pxToPanelPercent(
            targetRightPx,
            panelContainerWidth,
            DEFAULT_RIGHT_PANE_SIZE,
          ),
        );
      }
    } else if (!rightPaneOpen && prevRightOpen.current) {
      const panel = rightPaneRef.current;
      if (panel && !panel.isCollapsed()) {
        panel.collapse();
      }
    }
    prevRightOpen.current = rightPaneOpen;
  }, [rightPaneOpen, panelContainerWidth, targetRightPx]);

  const defaultLeftPanelSize = leftPaneOpen ? leftSizePct : 0;
  const defaultRightPanelSize = rightPaneOpen ? rightSizePct : 0;

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

  // Handle console modification from AI
  const handleConsoleModification = useCallback(
    async (modification: ConsoleModificationPayload) => {
      // handleConsoleModification called

      const { tabs, activeTabId, openTab, setActiveTab } =
        useConsoleStore.getState();
      const consoleTabs = Object.values(tabs);
      const activeConsoleId = activeTabId;

      const realConsoleTabs = (consoleTabs || []).filter(
        (t: any) => t?.kind === undefined || t?.kind === "console",
      );
      const activeRealConsoleId = realConsoleTabs.some(
        (t: any) => t.id === activeConsoleId,
      )
        ? activeConsoleId
        : null;

      // Handle console creation
      if (modification.action === "create" && modification.title) {
        const newConsoleId = openTab({
          id: modification.consoleId,
          title: modification.title,
          content: modification.content || "",
          connectionId: modification.connectionId,
          databaseId: modification.databaseId,
          databaseName: modification.databaseName,
          kind: "console",
          isDirty: modification.isDirty ?? true, // Agent-created consoles are dirty by default
        });
        setActiveTab(newConsoleId);
        return;
      }

      // Use the provided consoleId if available, otherwise use the active console
      let targetConsoleId = modification.consoleId || activeRealConsoleId;
      let isNewConsole = false;

      // If a consoleId was explicitly provided by the agent, trust it - the console was just created
      // and may not be in realConsoleTabs yet due to React state update timing.
      // Only fall back if no explicit consoleId was provided AND the resolved ID doesn't exist.
      if (
        !modification.consoleId &&
        targetConsoleId &&
        !realConsoleTabs.some((t: any) => t.id === targetConsoleId)
      ) {
        targetConsoleId = activeRealConsoleId;
      }

      if (!targetConsoleId) {
        // If no active console, try to open one
        if (realConsoleTabs.length > 0) {
          // Focus the first available real console
          targetConsoleId = realConsoleTabs[0].id;
          setActiveTab(targetConsoleId);
        } else {
          // Create a new console if none exist
          isNewConsole = true;
          const id = openTab({
            title: "AI Query",
            content: "",
          });
          targetConsoleId = id;
          setActiveTab(id);
        }
      }

      // If we just created a new console, wait a bit for it to mount
      if (isNewConsole) {
        // wait for mount
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // using console ID

      // Dispatch a custom event that the Editor component can listen to
      const event = new CustomEvent("console-modification", {
        detail: { consoleId: targetConsoleId, modification },
      });
      window.dispatchEvent(event);
    },
    [],
  );

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
        // If server call fails, fallback to type-based default
        const kind = (collection.type || "").toLowerCase();
        if (kind !== "collection" && kind !== "view") {
          prefill = `SELECT * FROM ${collection.name} LIMIT 500;`;
        }
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
        path,
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

  // Left pane content renderer
  const renderLeftPane = () => {
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
      case "settings":
        return <SettingsExplorer />;
      default:
        return null;
    }
  };

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

  return (
    <AuthWrapper>
      <UrlSync />
      <Box
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
          ref={panelContainerRef}
          sx={{ height: "100%", flex: 1, minWidth: 0 }}
        >
          <PanelGroup
            ref={panelGroupRef}
            direction="horizontal"
            style={{ height: "100%", width: "100%" }}
            onLayout={handleLayout}
          >
            <Panel
              ref={leftPaneRef}
              collapsible
              collapsedSize={0}
              defaultSize={defaultLeftPanelSize}
              minSize={collapseThresholdPct}
              onCollapse={() => setLeftPaneOpen(false)}
              onExpand={() => setLeftPaneOpen(true)}
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
                  {renderLeftPane()}
                </Suspense>
              </Box>
            </Panel>

            <StyledHorizontalResizeHandle
              onDragging={handleLeftPanelDragging}
              style={
                leftPaneOpen
                  ? undefined
                  : {
                      width: 0,
                      minWidth: 0,
                      opacity: 0,
                      pointerEvents: "none",
                    }
              }
            />

            {/* Editor + Results vertical layout inside Editor component */}
            <Panel minSize={EDITOR_PANEL_MIN_SIZE}>
              <Editor
                dbFlowFormRef={dbFlowFormRef}
                onChartSpecChangeRef={onChartSpecChangeRef}
                resultsContextRef={resultsContextRef}
              />
            </Panel>

            <StyledHorizontalResizeHandle
              onDragging={handleRightPanelDragging}
              style={
                rightPaneOpen
                  ? undefined
                  : {
                      width: 0,
                      minWidth: 0,
                      opacity: 0,
                      pointerEvents: "none",
                    }
              }
            />

            <Panel
              ref={rightPaneRef}
              collapsible
              collapsedSize={0}
              defaultSize={defaultRightPanelSize}
              minSize={collapseThresholdPct}
              onCollapse={() => setRightPaneOpen(false)}
              onExpand={() => setRightPaneOpen(true)}
            >
              <Box
                sx={{
                  height: "100%",
                  overflow: "hidden",
                  borderLeft: "1px solid",
                  borderColor: "divider",
                }}
              >
                <Chat
                  onConsoleModification={handleConsoleModification}
                  dbFlowFormRef={dbFlowFormRef}
                  onChartSpecChangeRef={onChartSpecChangeRef}
                  resultsContextRef={resultsContextRef}
                />
              </Box>
            </Panel>
          </PanelGroup>
        </Box>
      </Box>
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

// Auth route wrapper - redirects to "/" if already authenticated
function AuthRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  // If already authenticated, redirect to main app
  if (user) {
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
      <Routes>
        {/* Invite route - no authentication required */}
        <Route path="/invite/:token" element={<InvitePage />} />

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
