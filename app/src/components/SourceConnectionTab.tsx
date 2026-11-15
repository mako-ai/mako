import { useEffect, useState, useCallback, useRef } from "react";
import { Box, CircularProgress } from "@mui/material";
import SourceConnectionForm from "./SourceConnectionForm";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useSourceConnectionEntitiesStore } from "../store/sourceConnectionEntitiesStore";
import { useSourceConnectionStore } from "../store/sourceConnectionStore";
import { trackEvent } from "../lib/analytics";
import { connectorIconUrl } from "../lib/connector-icon";

interface SourceConnectionTabProps {
  /**
   * The id of the connector being edited. If undefined/empty -> create new.
   */
  sourceId?: string;
  /** Console tab id so we can close/update title */
  tabId: string;
}

const SourceConnectionTab: React.FC<SourceConnectionTabProps> = ({
  sourceId: initialSourceId,
  tabId,
}) => {
  const { currentWorkspace } = useWorkspace();
  const closeTab = useConsoleStore(s => s.closeTab);
  const updateTitle = useConsoleStore(s => s.updateTitle);
  const updateIcon = useConsoleStore(s => s.updateIcon);
  const updateContent = useConsoleStore(s => s.updateContent);
  const tabs = useConsoleStore(s => s.tabs);
  const updateDirty = useConsoleStore(s => s.updateDirty);
  const consoleTabs = Object.values(tabs);

  // Draft store
  const deleteDraft = useSourceConnectionStore(state => state.deleteDraft);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ------------------ global catalog ------------------ */
  const connectorTypes = useConnectorCatalogStore(s => s.types);
  const fetchCatalog = useConnectorCatalogStore(s => s.fetchCatalog);

  /* ------------------ entity cache -------------------- */
  const fetchConnector = useSourceConnectionEntitiesStore(s => s.fetchOne);
  const entities = useSourceConnectionEntitiesStore(s => s.entities);

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
      updateConsoleTitleRef.current(
        tabId,
        connector.name || "Source connection",
      );
      updateTabIcon(connector.type);
      setError(null);
      return;
    }
    setLoading(true);
    fetchConnector(currentWorkspace.id, effectiveSourceId).then(entity => {
      if (entity) {
        updateConsoleTitleRef.current(
          tabId,
          entity.name || "Source connection",
        );
        updateTabIcon(entity.type);
        setError(null);
      } else {
        setError("Failed to load source connection");
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
      const store = useSourceConnectionEntitiesStore.getState();
      // The store caches the saved entity (tab + sidebar list), so the
      // connector shows/updates immediately without a manual refresh.
      const { data: entity, error: saveError } = effectiveSourceId
        ? await store.update(currentWorkspace.id, effectiveSourceId, formData)
        : await store.create(currentWorkspace.id, formData);
      if (entity) {
        setError(null);
        updateTabIcon(entity.type);
        // Update the tab title once after a successful save
        updateTitle(tabId, entity.name || "Source connection");

        // Clear draft on successful save
        deleteDraft(tabId);

        const newId = entity._id;
        if (isNew && newId) {
          // Track connector creation
          trackEvent("connector_created", {
            connector_type: entity.type,
            connector_id: newId,
          });
          trackEvent("source_connection_created", {
            connector_type: entity.type,
            connector_id: newId,
            source_connection_id: newId,
          });

          // Persist the newly created connector id as the tab's content
          updateContent(tabId, newId);
          setLocalSourceId(newId);
        }
        return { success: true, isNew };
      } else {
        setError(saveError || "Failed to save source connection");
        return { success: false, isNew };
      }
    } catch (err: any) {
      console.error("Error saving source connection", err);
      setError(err.message || "Failed to save source connection");
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
      <SourceConnectionForm
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

export default SourceConnectionTab;
