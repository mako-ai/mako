import { useCallback, useEffect, useRef, useState } from "react";
import { loadMonaco } from "../../../lib/monaco/load";
import { useSqlAutocomplete } from "../../../hooks/useSqlAutocomplete";
import { isDbFlowQueryModelUri } from "../../../lib/sql-autocomplete/modelScope";
import { useConsoleStore } from "../../../store/consoleStore";

/**
 * The single global SQL autocomplete provider shared by every console: it
 * resolves the workspace / connection of whichever tab is active when the
 * completion is requested.
 */
export function useEditorSqlAutocomplete(
  workspaceId: string | undefined,
  availableDatabases: Array<{ id: string; type: string }>,
) {
  // Load Monaco instance for unified SQL autocomplete
  const [monacoInstance, setMonacoInstance] = useState<unknown>(null);
  useEffect(() => {
    // This used to be a bare loader.init().then(): when the CDN script
    // failed, the loader rejected with the script's error Event and it
    // surfaced as an unhandled rejection on every load. Monaco is bundled
    // now, but a failed chunk load must still not go unhandled.
    let active = true;
    loadMonaco()
      .then(monaco => {
        if (active) setMonacoInstance(monaco);
      })
      .catch((error: unknown) => {
        console.error("[monaco] failed to load the editor", error);
      });
    return () => {
      active = false;
    };
  }, []);

  // Dynamic getters for unified SQL autocomplete
  const getWorkspaceId = useCallback(() => workspaceId, [workspaceId]);

  const availableDatabasesRef = useRef(availableDatabases);
  useEffect(() => {
    availableDatabasesRef.current = availableDatabases;
  }, [availableDatabases]);

  const getConnectionId = useCallback(() => {
    const state = useConsoleStore.getState();
    const activeTab = state.activeTabId ? state.tabs[state.activeTabId] : null;
    return activeTab?.connectionId;
  }, []);

  const getConnectionType = useCallback(() => {
    const state = useConsoleStore.getState();
    const activeTab = state.activeTabId ? state.tabs[state.activeTabId] : null;
    const connectionId = activeTab?.connectionId;
    const connection = availableDatabasesRef.current.find(
      db => db.id === connectionId,
    );
    return connection?.type;
  }, []);

  useSqlAutocomplete({
    monaco: monacoInstance,
    getWorkspaceId,
    getConnectionId,
    getConnectionType,
    // DB flow query editors run their own provider (flow source connection).
    acceptsModel: uri => !isDbFlowQueryModelUri(uri),
  });
}
