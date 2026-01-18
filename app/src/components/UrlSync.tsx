import { useEffect, useRef } from "react";
import { useAppStore, useAppDispatch } from "../store";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";

/**
 * UrlSync component
 *
 * Responsibilities:
 * 1. Hydration (One-time on mount):
 *    Parses the initial URL and dispatches actions to restore state (open tabs, set view).
 *    This allows deep linking to specific resources.
 *
 * 2. Synchronization (Continuous):
 *    Listens to store changes (active tab, active view) and updates the URL silently
 *    using window.history.replaceState(). This prevents React Router from triggering
 *    unnecessary re-renders.
 */
export function UrlSync() {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const dispatch = useAppDispatch();

  // We need access to store methods but we don't want to trigger re-renders of this component
  // when the store changes, so we'll use the hooks but rely on the useEffect dependencies
  // to control when updates happen.
  const {
    activeConsoleId,
    consoleTabs,
    loadConsole,
    addConsoleTab,
    setActiveConsole,
    findTabByKind,
  } = useConsoleStore();

  const activeView = useAppStore(state => state.activeView);
  const { setActiveView } = useAppStore();

  // Ref to track if hydration has occurred to prevent double-hydration
  const isHydrated = useRef(false);

  // Reset hydration state when user logs out
  useEffect(() => {
    if (!user) {
      isHydrated.current = false;
    }
  }, [user]);

  // --- Hydration: Restore state from URL on mount ---
  useEffect(() => {
    // Don't hydrate if not authenticated or no workspace
    if (isHydrated.current || !currentWorkspace || !user) return;

    const path = window.location.pathname;

    // Regex patterns for routes
    const consoleMatch = path.match(/^\/c\/([a-zA-Z0-9-]+)/);
    const connectorMatch = path.match(/^\/cx\/([a-zA-Z0-9-]+)/);
    const flowMatch = path.match(/^\/f\/([a-zA-Z0-9-]+)/);
    const settingsMatch = path.match(/^\/settings/);

    if (consoleMatch) {
      // /c/:consoleId
      const consoleId = consoleMatch[1];
      setActiveView("consoles");

      // If the console isn't already open, try to load it
      // loadConsole handles checking existence internally
      loadConsole(consoleId, currentWorkspace.id);
    } else if (connectorMatch) {
      // /cx/:connectorId
      const connectorId = connectorMatch[1];
      setActiveView("connectors");

      // Check if we already have a tab for this connector
      const existingTab = consoleTabs.find(
        t => t.kind === "connectors" && t.content === connectorId,
      );

      if (existingTab) {
        setActiveConsole(existingTab.id);
      } else {
        // Create a new tab for this connector
        // We don't have the name yet, it will be fetched by ConnectorTab
        const id = addConsoleTab({
          title: "Connector", // Will be updated when entity loads
          content: connectorId,
          kind: "connectors",
        });
        setActiveConsole(id);
      }
    } else if (flowMatch) {
      // /f/:flowId
      const flowId = flowMatch[1];
      setActiveView("flows");

      // Check for existing tab
      const existingTab = consoleTabs.find(
        t => t.kind === "flow-editor" && t.metadata?.flowId === flowId,
      );

      if (existingTab) {
        setActiveConsole(existingTab.id);
      } else {
        const id = addConsoleTab({
          title: "Flow",
          content: "",
          kind: "flow-editor",
          metadata: { flowId },
        });
        setActiveConsole(id);
      }
    } else if (settingsMatch) {
      // /settings
      setActiveView("settings");

      // Open settings tab if not open
      const existingTab = findTabByKind("settings");
      if (existingTab) {
        setActiveConsole(existingTab.id);
      } else {
        const id = addConsoleTab({
          title: "Settings",
          content: "",
          kind: "settings",
        });
        setActiveConsole(id);
      }
    }

    isHydrated.current = true;
  }, [currentWorkspace, user]); // Only run when workspace is ready and user is authenticated

  // --- Synchronization: Update URL when state changes ---
  useEffect(() => {
    // Don't sync until after hydration or if user is not authenticated
    if (!isHydrated.current || !user) return;

    let newPath = "/";

    // Determine path based on active view and active tab
    if (activeView === "settings") {
      newPath = "/settings";
    } else if (activeView === "consoles") {
      if (activeConsoleId) {
        const tab = consoleTabs.find(t => t.id === activeConsoleId);
        // Ensure we only link to actual consoles in the console view
        if (tab && (tab.kind === "console" || !tab.kind)) {
          newPath = `/c/${activeConsoleId}`;
        }
      }
    } else if (activeView === "connectors") {
      // If a specific connector tab is focused
      if (activeConsoleId) {
        const tab = consoleTabs.find(t => t.id === activeConsoleId);
        if (tab && tab.kind === "connectors" && tab.content) {
          // content holds the sourceId for connectors
          newPath = `/cx/${tab.content}`;
        }
      }
    } else if (activeView === "flows") {
      if (activeConsoleId) {
        const tab = consoleTabs.find(t => t.id === activeConsoleId);
        if (tab && tab.kind === "flow-editor" && tab.metadata?.flowId) {
          newPath = `/f/${tab.metadata.flowId}`;
        }
      }
    }

    // Only update if changed to avoid noise (though replaceState is cheap)
    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, "", newPath);
    }
  }, [activeView, activeConsoleId, consoleTabs, user]); // Re-run when relevant state changes

  return null; // This component renders nothing
}
