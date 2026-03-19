import { useEffect, useRef, lazy } from "react";
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
import { useUIStore } from "./store/uiStore";
import { useConsoleStore } from "./store/consoleStore";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Chat from "./components/Chat";
import DatabaseExplorer from "./components/DatabaseExplorer";
import ConsoleExplorer from "./components/ConsoleExplorer";
import DataSourceExplorer from "./components/ConnectorExplorer";
import Editor from "./components/Editor";
import { FlowsExplorer } from "./components/FlowsExplorer";
const DashboardsExplorer = lazy(
  () => import("./components/DashboardsExplorer"),
);
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
function MainApp() {
  const activeView = useUIStore(s => s.leftPane);
  // Avoid re-rendering MainApp on console state changes; use getState on demand

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
  const handleConsoleModification = async (
    modification: ConsoleModificationPayload,
  ) => {
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
  };

  const openOrFocusConsoleTab = (
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
      // Update the content in case it changed on the server
      updateContent(existing.id, content);
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
  };

  // Left pane content renderer
  const renderLeftPane = () => {
    switch (activeView) {
      case "databases":
        return (
          <DatabaseExplorer
            onCollectionClick={async (dbId, collection) => {
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
            }}
          />
        );
      case "consoles":
        return (
          <ConsoleExplorer
            onConsoleSelect={(
              path,
              content,
              connectionId,
              consoleId,
              isPlaceholder,
              databaseId,
              databaseName,
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
            }}
          />
        );
      case "connectors":
        return <DataSourceExplorer />;
      case "flows":
        return <FlowsExplorer />;
      case "dashboards":
        return <DashboardsExplorer />;
      default:
        return null;
    }
  };

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

        <PanelGroup
          direction="horizontal"
          style={{ height: "100%", width: "100%" }}
        >
          <Panel defaultSize={15} minSize={10}>
            <Box sx={{ height: "100%", overflow: "hidden" }}>
              {renderLeftPane()}
            </Box>
          </Panel>

          <StyledHorizontalResizeHandle />

          {/* Editor + Results vertical layout inside Editor component */}
          <Panel defaultSize={30} minSize={30}>
            <Editor
              dbFlowFormRef={dbFlowFormRef}
              onChartSpecChangeRef={onChartSpecChangeRef}
              resultsContextRef={resultsContextRef}
            />
          </Panel>

          <StyledHorizontalResizeHandle />

          <Panel defaultSize={30} minSize={10}>
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
