import { useEffect, useState, useCallback, useRef } from "react";
import { Box, CircularProgress } from "@mui/material";
import ConnectorForm from "./ConnectorForm";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorEntitiesStore } from "../store/connectorEntitiesStore";
import { useConnectorStore } from "../store/connectorStore";
import { trackEvent } from "../lib/analytics";

interface ConnectorType {
  type: string;
  name: string;
  version: string;
  description: string;
  supportedEntities: string[];
}

interface ConnectorTabProps {
  /**
   * The id of the connector being edited. If undefined/empty -> create new.
   */
  sourceId?: string;
  /** Console tab id so we can close/update title */
  tabId: string;
}

const ConnectorTab: React.FC<ConnectorTabProps> = ({
  sourceId: initialSourceId,
  tabId,
}) => {
  const { currentWorkspace } = useWorkspace();
  const {
    removeConsoleTab,
    updateConsoleTitle,
    updateConsoleIcon,
    updateConsoleContent,
    consoleTabs,
    updateConsoleDirty,
  } = useConsoleStore();

  // Draft store
  const deleteDraft = useConnectorStore(state => state.deleteDraft);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ------------------ global catalog ------------------ */
  const { types: connectorTypes, fetchCatalog } = useConnectorCatalogStore();

  /* ------------------ entity cache -------------------- */
  const {
    fetchOne: fetchConnector,
    upsert: upsertConnector,
    entities,
  } = useConnectorEntitiesStore();

  const [localSourceId, setLocalSourceId] = useState<string | undefined>(
    initialSourceId,
  );
  const effectiveSourceId = localSourceId;
  const connectorKey =
    currentWorkspace && effectiveSourceId
      ? `${currentWorkspace.id}:${effectiveSourceId}`
      : null;
  const connector = connectorKey ? (entities as any)[connectorKey] : null;

  const updateConsoleTitleRef = useRef(updateConsoleTitle);
  const consoleTabsRef = useRef(consoleTabs);

  // keep refs in sync
  useEffect(() => {
    updateConsoleTitleRef.current = updateConsoleTitle;
  });
  useEffect(() => {
    consoleTabsRef.current = consoleTabs;
  }, [consoleTabs]);

  // Helper to update the tab icon based on connector type
  const updateTabIcon = useCallback(
    (type: string) => {
      updateConsoleIcon(tabId, `/api/connectors/${type}/icon.svg`);
    },
    [updateConsoleIcon, tabId],
  );

  /* ------------------ effects ------------------ */
  // Always fetch fresh connector catalog when component mounts or workspace changes
  useEffect(() => {
    if (!currentWorkspace) return;
    fetchCatalog(currentWorkspace.id);
  }, [currentWorkspace, fetchCatalog]);

  // Fetch connector entity if needed
  useEffect(() => {
    if (!currentWorkspace || !effectiveSourceId) return;
    if (connector) {
      // ensure title/icon update once entity arrives
      updateConsoleTitleRef.current(tabId, connector.name || "Connector");
      updateTabIcon(connector.type);
      setError(null);
      return;
    }
    setLoading(true);
    fetchConnector(currentWorkspace.id, effectiveSourceId).then(entity => {
      if (entity) {
        updateConsoleTitleRef.current(tabId, entity.name || "Connector");
        updateTabIcon(entity.type);
        setError(null);
      } else {
        setError("Failed to load connector");
      }
      setLoading(false);
    });
  }, [
    currentWorkspace,
    effectiveSourceId,
    connector,
    fetchConnector,
    tabId,
    updateTabIcon,
  ]);

  /* ------------------ handlers ------------------ */
  const handleClose = () => {
    deleteDraft(tabId);
    removeConsoleTab(tabId);
  };

  const handleSubmit = async (formData: any) => {
    if (!currentWorkspace) return;

    try {
      const url = effectiveSourceId
        ? `/api/workspaces/${currentWorkspace.id}/connectors/${effectiveSourceId}`
        : `/api/workspaces/${currentWorkspace.id}/connectors`;
      const method = effectiveSourceId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await response.json();
      if (data.success) {
        // update entity cache
        if (currentWorkspace) {
          upsertConnector({ ...data.data, workspaceId: currentWorkspace.id });
        }
        setError(null);
        updateTabIcon(data.data.type);
        // Update the tab title once after a successful save
        updateConsoleTitle(tabId, data.data.name || "Connector");

        // Clear draft on successful save
        deleteDraft(tabId);

        const newId = data.data._id;
        if (!effectiveSourceId && newId) {
          // Track connector creation
          trackEvent("connector_created", {
            connector_type: data.data.type,
            connector_id: newId,
          });

          // Persist the newly created connector id as the tab's content
          updateConsoleContent(tabId, newId);
          setLocalSourceId(newId);
        }
      } else {
        const serverError = data.error || data.message || JSON.stringify(data);
        setError(serverError);
      }
    } catch (err: any) {
      console.error("Error saving connector", err);
      setError(err.message || "Failed to save connector");
    }
  };

  /* ------------------ render -------------------- */
  if (loading) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        p: 1,
        overflow: "auto",
        bgcolor: "background.paper",
      }}
    >
      <ConnectorForm
        variant="inline"
        tabId={tabId}
        onClose={handleClose}
        onSubmit={handleSubmit}
        connector={connector}
        connectorTypes={connectorTypes || []}
        errorMessage={error}
        onDirtyChange={dirty => updateConsoleDirty(tabId, dirty)}
      />
    </Box>
  );
};

export default ConnectorTab;
