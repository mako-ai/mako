import { useEffect, useState, useCallback, useRef } from "react";
import { Box, CircularProgress } from "@mui/material";
import ConnectorForm from "./ConnectorForm";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorEntitiesStore } from "../store/connectorEntitiesStore";
import { useConnectorStore } from "../store/connectorStore";
import { trackEvent } from "../lib/analytics";
import { connectorIconUrl } from "../lib/connector-icon";

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
    closeTab,
    updateTitle,
    updateIcon,
    updateContent,
    tabs,
    updateDirty,
  } = useConsoleStore();
  const consoleTabs = Object.values(tabs);

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
  const connector = connectorKey ? entities[connectorKey] : null;

  const updateConsoleTitleRef = useRef(updateTitle);
  const consoleTabsRef = useRef(consoleTabs);

  // keep refs in sync
  useEffect(() => {
    updateConsoleTitleRef.current = updateTitle;
  });
  useEffect(() => {
    consoleTabsRef.current = consoleTabs;
  }, [consoleTabs]);

  // Helper to update the tab icon based on connector type
  const updateTabIcon = useCallback(
    (type: string) => {
      updateIcon(tabId, connectorIconUrl(type, currentWorkspace?.id));
    },
    [updateIcon, tabId, currentWorkspace?.id],
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
    closeTab(tabId);
  };

  const handleSubmit = async (
    formData: any,
  ): Promise<{ success: boolean; isNew: boolean }> => {
    const isNew = !effectiveSourceId;
    if (!currentWorkspace) return { success: false, isNew };

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
        const entity = { ...data.data, workspaceId: currentWorkspace.id };
        // Update the tab's entity cache and the sidebar list's cache so the
        // connector shows/updates immediately without a manual refresh.
        upsertConnector(entity);
        setError(null);
        updateTabIcon(data.data.type);
        // Update the tab title once after a successful save
        updateTitle(tabId, data.data.name || "Connector");

        // Clear draft on successful save
        deleteDraft(tabId);

        const newId = data.data._id;
        if (isNew && newId) {
          // Track connector creation
          trackEvent("connector_created", {
            connector_type: data.data.type,
            connector_id: newId,
          });

          // Persist the newly created connector id as the tab's content
          updateContent(tabId, newId);
          setLocalSourceId(newId);
        }
        return { success: true, isNew };
      } else {
        const serverError = data.error || data.message || JSON.stringify(data);
        setError(serverError);
        return { success: false, isNew };
      }
    } catch (err: any) {
      console.error("Error saving connector", err);
      setError(err.message || "Failed to save connector");
      return { success: false, isNew };
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
        onDirtyChange={dirty => updateDirty(tabId, dirty)}
      />
    </Box>
  );
};

export default ConnectorTab;
