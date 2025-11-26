import { useEffect, useRef } from "react";
import { useAppStore, useAppDispatch } from "../store";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorEntitiesStore } from "../store/connectorEntitiesStore";

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
    findTabByKind 
  } = useConsoleStore();
  
  const activeView = useAppStore(state => state.activeView);
  const { setActiveView } = useAppStore();
  
  // Ref to track if hydration has occurred to prevent double-hydration
  const isHydrated = useRef(false);

  // --- Hydration: Restore state from URL on mount ---
  useEffect(() => {
    if (isHydrated.current || !currentWorkspace) return;
    
    const path = window.location.pathname;
    
    // Regex patterns for routes
    const consoleMatch = path.match(/^\/c\/([a-zA-Z0-9-]+)/);
    const connectorMatch = path.match(/^\/cx\/([a-zA-Z0-9-]+)/);
    const transferMatch = path.match(/^\/t\/([a-zA-Z0-9-]+)/);
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
        t => t.kind === "connectors" && t.content === connectorId
      );
      
      if (existingTab) {
        setActiveConsole(existingTab.id);
      } else {
        // Create a new tab for this connector
        // We don't have the name yet, it will be fetched by ConnectorTab
        const id = addConsoleTab({
          title: "Connector", // Will be updated when entity loads
          content: connectorId,
          initialContent: connectorId,
          kind: "connectors",
        });
        setActiveConsole(id);
      }
      
    } else if (transferMatch) {
      // /t/:transferId
      const transferId = transferMatch[1];
      setActiveView("sync-jobs");
      
      // Similar logic for sync jobs / transfers
      // Note: Sync jobs might be handled differently in your UI (e.g. modal vs tab)
      // Assuming tab-based approach similar to connectors for now based on user request
      // If "Transfers" is just a list view, we might just switch the view.
      // But user asked for "/t/{transfer_id}", implying a specific detail view.
      
      // Check for existing tab
      const existingTab = consoleTabs.find(
        t => t.kind === "sync-job-editor" && t.metadata?.jobId === transferId
      );

      if (existingTab) {
        setActiveConsole(existingTab.id);
      } else {
        const id = addConsoleTab({
          title: "Transfer",
          content: "", 
          initialContent: "",
          kind: "sync-job-editor",
          metadata: { jobId: transferId }
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
          initialContent: "",
          kind: "settings"
        });
        setActiveConsole(id);
      }
    }
    
    isHydrated.current = true;
  }, [currentWorkspace]); // Only run when workspace is ready


  // --- Synchronization: Update URL when state changes ---
  useEffect(() => {
    if (!isHydrated.current) return; // Don't sync until after hydration

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
    } else if (activeView === "sync-jobs") {
       if (activeConsoleId) {
        const tab = consoleTabs.find(t => t.id === activeConsoleId);
        if (tab && tab.kind === "sync-job-editor" && tab.metadata?.jobId) {
           newPath = `/t/${tab.metadata.jobId}`;
        }
      }
    }
    
    // Only update if changed to avoid noise (though replaceState is cheap)
    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, "", newPath);
    }

  }, [activeView, activeConsoleId, consoleTabs]); // Re-run when relevant state changes

  return null; // This component renders nothing
}

