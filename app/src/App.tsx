import {
  Suspense,
  useCallback,
  useEffect,
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
  CENTER_PANE_MIN_WIDTH_PX,
  DEFAULT_LEFT_PANE_WIDTH_PX,
  DEFAULT_RIGHT_PANE_WIDTH_PX,
  SIDE_PANEL_COLLAPSE_THRESHOLD_PX,
  SIDE_PANEL_MAX_WIDTH_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
  useUIStore,
} from "./store/uiStore";
import { useConsoleStore } from "./store/consoleStore";
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
const loadAppsExplorer = () => import("./components/AppsExplorer");
const AppsExplorer = lazy(loadAppsExplorer);
import { AuthWrapper } from "./components/AuthWrapper";
import { AcceptInvite } from "./components/AcceptInvite";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { OnboardingProvider } from "./contexts/onboarding-context";
import type { DbFlowFormRef } from "./components/DbFlowForm";
import { generateObjectId } from "./utils/objectId";
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

// Draggable divider between a fixed-width side pane and the flexible center.
// Resizing changes the side pane's pixel width directly (not a percentage),
// so side panes stay a fixed width and only the center pane flexes.
const ResizeDivider = styled("div")(({ theme }) => ({
  flex: "0 0 4px",
  width: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  cursor: "col-resize",
  touchAction: "none",
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type SidePane = "left" | "right";

function MainApp() {
  const activeView = useUIStore(state => state.leftPane);
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const closeLeftPane = useUIStore(state => state.closeLeftPane);
  const closeRightPane = useUIStore(state => state.closeRightPane);
  const leftPaneWidthPx = useUIStore(state => state.leftPaneWidthPx);
  const rightPaneWidthPx = useUIStore(state => state.rightPaneWidthPx);
  const setPaneWidths = useUIStore(state => state.setPaneWidths);

  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const leftPaneElRef = useRef<HTMLDivElement | null>(null);
  const rightPaneElRef = useRef<HTMLDivElement | null>(null);

  // Side panes have a FIXED pixel width. Only the center pane flexes to fill
  // the remaining space, so resizing the window never changes the side panes —
  // it only grows/shrinks the center (Slack/Cursor behavior). The width is a
  // local px value, seeded from (and persisted back to) the UI store.
  const [leftWidth, setLeftWidth] = useState(() =>
    leftPaneWidthPx && leftPaneWidthPx > 0
      ? clamp(leftPaneWidthPx, SIDE_PANEL_MIN_WIDTH_PX, SIDE_PANEL_MAX_WIDTH_PX)
      : DEFAULT_LEFT_PANE_WIDTH_PX,
  );
  const [rightWidth, setRightWidth] = useState(() =>
    rightPaneWidthPx && rightPaneWidthPx > 0
      ? clamp(
          rightPaneWidthPx,
          SIDE_PANEL_MIN_WIDTH_PX,
          SIDE_PANEL_MAX_WIDTH_PX,
        )
      : DEFAULT_RIGHT_PANE_WIDTH_PX,
  );

  // Mirror widths into refs so the drag handler reads fresh values without
  // being re-created on every width change.
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  leftWidthRef.current = leftWidth;
  rightWidthRef.current = rightWidth;

  // Keep local widths in sync if the persisted store value changes elsewhere.
  useEffect(() => {
    if (leftPaneWidthPx && leftPaneWidthPx > 0) {
      setLeftWidth(
        clamp(
          leftPaneWidthPx,
          SIDE_PANEL_MIN_WIDTH_PX,
          SIDE_PANEL_MAX_WIDTH_PX,
        ),
      );
    }
  }, [leftPaneWidthPx]);
  useEffect(() => {
    if (rightPaneWidthPx && rightPaneWidthPx > 0) {
      setRightWidth(
        clamp(
          rightPaneWidthPx,
          SIDE_PANEL_MIN_WIDTH_PX,
          SIDE_PANEL_MAX_WIDTH_PX,
        ),
      );
    }
  }, [rightPaneWidthPx]);

  // Begin a manual drag-resize of a side pane. The new width is applied
  // imperatively to the pane element during the drag (so heavy children like
  // the editor/chat don't re-render on every pointer move), then committed to
  // React state + the store on release.
  const beginResize = useCallback(
    (side: SidePane, e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();

      const container = panelContainerRef.current;
      const containerWidth = container
        ? container.clientWidth
        : window.innerWidth;
      const startX = e.clientX;
      const startWidth =
        side === "left" ? leftWidthRef.current : rightWidthRef.current;
      const otherWidth =
        side === "left"
          ? rightPaneOpen
            ? rightWidthRef.current
            : 0
          : leftPaneOpen
            ? leftWidthRef.current
            : 0;

      // Cap so the center pane keeps a usable minimum width.
      const maxWidth = Math.max(
        SIDE_PANEL_MIN_WIDTH_PX,
        Math.min(
          SIDE_PANEL_MAX_WIDTH_PX,
          containerWidth - otherWidth - CENTER_PANE_MIN_WIDTH_PX - 8,
        ),
      );

      const el =
        side === "left" ? leftPaneElRef.current : rightPaneElRef.current;
      let finalWidth = startWidth;
      let shouldCollapse = false;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const raw = side === "left" ? startWidth + delta : startWidth - delta;
        shouldCollapse = raw < SIDE_PANEL_COLLAPSE_THRESHOLD_PX;
        if (shouldCollapse) {
          finalWidth = 0;
          if (el) el.style.width = "0px";
          return;
        }

        finalWidth = clamp(raw, SIDE_PANEL_MIN_WIDTH_PX, maxWidth);
        if (el) el.style.width = `${finalWidth}px`;
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        if (shouldCollapse) {
          if (side === "left") {
            closeLeftPane();
          } else {
            closeRightPane();
          }
          return;
        }

        if (side === "left") {
          setLeftWidth(finalWidth);
          setPaneWidths({ leftPaneWidthPx: finalWidth });
        } else {
          setRightWidth(finalWidth);
          setPaneWidths({ rightPaneWidthPx: finalWidth });
        }
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [closeLeftPane, closeRightPane, leftPaneOpen, rightPaneOpen, setPaneWidths],
  );

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
      case "apps":
        return <AppsExplorer />;
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
          ref={panelContainerRef}
          sx={{
            height: "100%",
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "row",
          }}
        >
          {/* Left side pane — fixed pixel width, resizable by hand */}
          {leftPaneOpen && (
            <>
              <Box
                ref={leftPaneElRef}
                style={{ width: leftWidth }}
                sx={{
                  flex: "0 0 auto",
                  flexShrink: 0,
                  height: "100%",
                  overflow: "hidden",
                }}
              >
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
              <ResizeDivider onPointerDown={e => beginResize("left", e)} />
            </>
          )}

          {/* Center (main content) — flexes to fill remaining space */}
          <Box
            data-mako-main-content="true"
            sx={{ flex: "1 1 0", minWidth: 0, height: "100%" }}
          >
            <Editor
              dbFlowFormRef={dbFlowFormRef}
              onChartSpecChangeRef={onChartSpecChangeRef}
              resultsContextRef={resultsContextRef}
            />
          </Box>

          {/* Right side pane (chat) — fixed pixel width, resizable by hand */}
          {rightPaneOpen && (
            <>
              <ResizeDivider onPointerDown={e => beginResize("right", e)} />
              <Box
                ref={rightPaneElRef}
                style={{ width: rightWidth }}
                sx={{
                  flex: "0 0 auto",
                  flexShrink: 0,
                  height: "100%",
                  overflow: "hidden",
                  borderLeft: "1px solid",
                  borderColor: "divider",
                }}
              >
                <Chat
                  dbFlowFormRef={dbFlowFormRef}
                  onChartSpecChangeRef={onChartSpecChangeRef}
                  resultsContextRef={resultsContextRef}
                />
              </Box>
            </>
          )}
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

  // If already authenticated, resume a pending desktop sign-in handoff or
  // redirect to the main app
  if (user) {
    if (hasPendingDesktopAuth()) {
      return <Navigate to="/desktop-auth" replace />;
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
      <DesktopAuthResume />
      <UpdateNotification />
      <Routes>
        {/* Invite route - no authentication required */}
        <Route path="/invite/:token" element={<InvitePage />} />

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
