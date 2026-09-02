import { useEffect, useState, useMemo } from "react";
import {
  Box,
  Typography,
  IconButton,
  CircularProgress,
  Tooltip,
  MenuItem,
} from "@mui/material";
import {
  Plus as AddIcon,
  RotateCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";

import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useSourceConnectionEntitiesStore } from "../store/sourceConnectionEntitiesStore";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import ResourceTree, {
  type ResourceTreeNode,
  type ResourceTreeSection,
} from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";
import { ConfirmDialog } from "./ConfirmDialog";
import { connectorIconUrl } from "../lib/connector-icon";

interface SourceConnectionRow {
  _id: string;
  name: string;
  description?: string;
  type: string;
  isActive: boolean;
  workspaceId: string;
}

function SourceConnectionExplorer() {
  const { currentWorkspace } = useWorkspace();
  const { tabs, activeTabId, openTab, setActiveTab } = useConsoleStore();
  const consoleTabs = Object.values(tabs);
  const activeConsoleId = activeTabId;
  const {
    entities,
    loading,
    init,
    refresh,
    delete: deleteSource,
  } = useSourceConnectionEntitiesStore();

  const connectors: SourceConnectionRow[] = useMemo(() => {
    if (!currentWorkspace) return [];
    return Object.values(entities).filter(
      e => e.workspaceId === currentWorkspace.id,
    ) as SourceConnectionRow[];
  }, [entities, currentWorkspace]);

  const connectorById = useMemo(() => {
    const map = new Map<string, SourceConnectionRow>();
    for (const c of connectors) map.set(c._id, c);
    return map;
  }, [connectors]);

  const [error] = useState<string | null>(null);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SourceConnectionRow | null>(
    null,
  );

  const fetchSources = async () => {
    if (!currentWorkspace) return;
    await refresh(currentWorkspace.id);
  };

  useEffect(() => {
    if (currentWorkspace) {
      init(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id]);

  const openTabForSource = (source?: SourceConnectionRow) => {
    if (source) {
      const contentKey = source._id;
      const existing = consoleTabs.find(
        t => t.kind === "connectors" && t.content === contentKey,
      );
      if (existing) {
        setActiveTab(existing.id);
        return;
      }

      const id = openTab({
        title: source.name,
        content: contentKey,
        kind: "connectors",
        icon: connectorIconUrl(source.type, currentWorkspace?.id),
      });
      setActiveTab(id);
    } else {
      const id = openTab({
        title: "New source connection",
        content: "",
        kind: "connectors",
      });
      setActiveTab(id);
    }
  };

  const handleAdd = () => openTabForSource(undefined);

  const handleDelete = (item: SourceConnectionRow) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem) return;
    const res = await deleteSource(currentWorkspace.id, selectedItem._id);
    if (!res.success) {
      console.error("Failed to delete data source:", res.error);
    }
    setDeleteDialogOpen(false);
    setSelectedItem(null);
  };

  const sections = useMemo<ResourceTreeSection[]>(
    () => [
      {
        key: "connectors",
        label: "",
        hideSectionHeader: true,
        nodes: connectors.map(c => ({
          id: c._id,
          name: c.name,
          path: c.name,
          isDirectory: false,
        })),
      },
    ],
    [connectors],
  );

  const getItemIcon = (node: ResourceTreeNode) => {
    const src = connectorById.get(node.id);
    if (!src) return null;
    return (
      <Box
        component="img"
        src={connectorIconUrl(src.type, currentWorkspace?.id)}
        alt={`${src.type} icon`}
        sx={{ width: 20, height: 20, display: "block", flexShrink: 0 }}
      />
    );
  };

  const activeConnectorId = useMemo(() => {
    if (!activeConsoleId) return null;
    const tab = consoleTabs.find(
      t =>
        t.id === activeConsoleId &&
        t.kind === "connectors" &&
        typeof t.content === "string",
    );
    return tab?.content ?? null;
  }, [consoleTabs, activeConsoleId]);

  const reveal = useExplorerRevealStore(selectRevealFor("connectors"));

  const actions = (
    <>
      <Tooltip title="Add source connection">
        <IconButton size="small" onClick={handleAdd}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={fetchSources}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const isLoading = !!(currentWorkspace && loading[currentWorkspace.id]);

  return (
    <>
      <ExplorerShell
        title="Sources"
        actions={actions}
        searchPlaceholder="Search source connections..."
        error={error}
        loading={isLoading && connectors.length === 0}
        skeleton={
          <Box sx={{ p: 2, textAlign: "center" }}>
            <CircularProgress size={24} />
          </Box>
        }
      >
        {({ searchQuery }) =>
          connectors.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
              <Typography variant="body2">
                No source connections configured.
              </Typography>
            </Box>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              activeItemId={activeConnectorId || undefined}
              revealNodeId={reveal?.nodeId}
              revealNonce={reveal?.nonce}
              getItemIcon={getItemIcon}
              hideFolderIcon
              isFolderExpanded={() => true}
              onToggleFolder={() => {}}
              onExpandFolder={() => {}}
              getFolderExpansionKey={node => node.id}
              onItemClick={node => {
                const src = connectorById.get(node.id);
                if (src) openTabForSource(src);
              }}
              getContextMenuItems={(node, { closeMenu }) => {
                const src = connectorById.get(node.id);
                if (!src) return null;
                return [
                  <MenuItem
                    key="delete"
                    onClick={() => {
                      closeMenu();
                      handleDelete(src);
                    }}
                  >
                    <DeleteIcon
                      size={16}
                      strokeWidth={1.5}
                      style={{ marginRight: 8 }}
                    />
                    Delete
                  </MenuItem>,
                ];
              }}
            />
          )
        }
      </ExplorerShell>

      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete source connection"
        body={`This will permanently delete the source connection. Are you sure you want to delete "${selectedItem?.name}"?`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteDialogOpen(false)}
      />
    </>
  );
}

export default SourceConnectionExplorer;
