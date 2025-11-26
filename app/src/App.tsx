import { Box, styled } from "@mui/material";
import { Routes, Route, useParams } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import { useAppStore, useChatStore } from "./store";
import { useConsoleStore } from "./store/consoleStore";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Chat from "./components/Chat";
import DatabaseExplorer from "./components/DatabaseExplorer";
import ConsoleExplorer from "./components/ConsoleExplorer";
import DataSourceExplorer from "./components/ConnectorExplorer";
import Editor from "./components/Editor";
import { SyncJobsExplorer } from "./components/SyncJobsExplorer";
import { AuthWrapper } from "./components/AuthWrapper";
import { AcceptInvite } from "./components/AcceptInvite";
import { WorkspaceProvider } from "./contexts/workspace-context";
import { ConsoleModification } from "./hooks/useMonacoConsole";
import { generateObjectId } from "./utils/objectId";

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

// Main application component (extracted from original App)
function MainApp() {
  const activeView = useAppStore(s => s.activeView);
  // Avoid re-rendering MainApp on console state changes; use getState on demand

  // Handle console modification from AI
  const handleConsoleModification = async (
    modification: ConsoleModification & { consoleId?: string; title?: string },
  ) => {
    // handleConsoleModification called

    const { activeConsoleId, consoleTabs, addConsoleTab, setActiveConsole } =
      useConsoleStore.getState();

    // Handle console creation
    if (modification.action === "create" && modification.title) {
      const newConsoleId = addConsoleTab({
        title: modification.title,
        content: modification.content || "",
        initialContent: modification.content || "",
      });
      setActiveConsole(newConsoleId);
      return;
    }

    // Use the provided consoleId if available, otherwise use the active console
    let targetConsoleId = modification.consoleId || activeConsoleId;
    let isNewConsole = false;

    if (!targetConsoleId) {
      // If no active console, try to open one
      if (consoleTabs.length > 0) {
        // Focus the first available console
        targetConsoleId = consoleTabs[0].id;
        setActiveConsole(targetConsoleId);
      } else {
        // Create a new console if none exist
        isNewConsole = true;
        const id = addConsoleTab({
          title: "AI Query",
          content: "",
          initialContent: "",
        });
        targetConsoleId = id;
        setActiveConsole(id);
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
    extraContextItems: any[] = [],
    filePath?: string,
    consoleId?: string, // Add optional consoleId parameter
    isPlaceholder?: boolean,
    queryOptions?: Record<string, any>, // Options to pass when executing (e.g., D1 databaseId)
  ) => {
    // For existing consoles, use the server ID as the tab ID
    const tabId = consoleId || generateObjectId();

    const {
      consoleTabs,
      setActiveConsole,
      addConsoleTab,
      updateConsoleContent,
    } = useConsoleStore.getState();

    // Check if a tab with this ID already exists
    const existing = consoleTabs.find(t => t.id === tabId);

    if (existing) {
      // Tab already exists, just focus it
      setActiveConsole(existing.id);
      // Update the content in case it changed on the server
      updateConsoleContent(existing.id, content);
      useChatStore.getState().ensureContextItems([
        {
          id: existing.id,
          type: "console",
          title,
          content,
          metadata: { consoleId: existing.id, filePath },
        },
        ...extraContextItems,
      ]);
      return;
    }

    // Extract databaseId and databaseName from queryOptions (e.g., for D1 cluster mode)
    // D1 uses databaseName for the UUID, other DBs may use databaseId or dbName
    const databaseId =
      queryOptions?.databaseId ||
      queryOptions?.databaseName; // D1 stores UUID in databaseName
    const databaseName =
      queryOptions?.databaseLabel || // Human-readable name if available
      queryOptions?.dbName;

    // Create a new tab with the determined ID
    const id = addConsoleTab({
      id: tabId, // Pass the ID explicitly
      title,
      content,
      initialContent: content,
      connectionId,
      databaseId, // D1 database UUID or other DB-specific ID
      databaseName, // Human-readable database name
      // If placeholder, defer setting filePath so dbContentHash isn't computed
      filePath: isPlaceholder ? undefined : filePath,
      // Store query execution options for backward compatibility
      metadata: queryOptions ? { queryOptions } : undefined,
    });
    setActiveConsole(id);

    useChatStore.getState().ensureContextItems([
      {
        id,
        type: "console",
        title,
        content,
        metadata: { consoleId: id, filePath },
      },
      ...extraContextItems,
    ]);
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
                const { useDatabaseContentStore } = await import(
                  "./store/databaseContentStore"
                );
                const workspaceId = localStorage.getItem("activeWorkspaceId");
                if (workspaceId) {
                  const tpl = await useDatabaseContentStore
                    .getState()
                    .fetchConsoleTemplate(workspaceId, dbId, {
                      id: collection.name,
                      kind: collection.type || "collection",
                      metadata: collection.options,
                    } as any);
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
                [
                  {
                    id: "collection-" + collection.name,
                    type: "collection",
                    title: collection.name,
                    content: `Collection: ${collection.name}`,
                    metadata: {
                      connectionId: dbId,
                      collectionName: collection.name,
                    },
                  },
                ],
                undefined, // filePath
                undefined, // consoleId
                undefined, // isPlaceholder
                collection.options, // queryOptions - contains D1 databaseName (UUID), MongoDB dbName, etc.
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
            ) => {
              openOrFocusConsoleTab(
                path,
                content,
                connectionId,
                [],
                path,
                consoleId,
                isPlaceholder,
              );
            }}
          />
        );
      case "connectors":
        return <DataSourceExplorer />;
      case "sync-jobs":
        return <SyncJobsExplorer />;
      // Add others as needed
      default:
        return null;
    }
  };

  return (
    <AuthWrapper>
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
            <Editor />
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
              <Chat onConsoleModification={handleConsoleModification} />
            </Box>
          </Panel>
        </PanelGroup>
      </Box>
    </AuthWrapper>
  );
}

function App() {
  return (
    <Routes>
      {/* Invite route - no authentication required */}
      <Route path="/invite/:token" element={<InvitePage />} />

      {/* Main app route - authentication required */}
      <Route path="/*" element={<MainApp />} />
    </Routes>
  );
}

export default App;
