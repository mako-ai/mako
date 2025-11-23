import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Alert,
  IconButton,
  Skeleton,
  Menu,
  MenuItem,
  Tooltip,
} from "@mui/material";
import {
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Database as DatabaseIcon,
  Table as CollectionIcon,
  Eye as ViewIcon,
  RotateCw as RefreshIcon,
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Plus as AddIcon,
  Trash2 as DeleteIcon,
  Settings as SettingsIcon,
  Layers as LayersIcon,
} from "lucide-react";
import { useDatabaseExplorerStore } from "../store";
import { useWorkspace } from "../contexts/workspace-context";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import { useDatabaseStore, CollectionInfo } from "../store/databaseStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useDatabaseTreeStore, TreeNode } from "../store/databaseTreeStore";
import { useConsoleStore } from "../store/consoleStore";

// Removed inline MongoDB icon; icons are served by API per database type

const IconImg = React.memo(
  ({ src, alt, size = 20 }: { src: string; alt: string; size?: number }) => (
    <img
      src={src}
      alt={alt}
      style={{ width: size, height: size, display: "block" }}
      loading="lazy"
    />
  ),
);
IconImg.displayName = "IconImg";

const DatabaseTypeIcon = React.memo(
  ({
    type,
    typeToIconUrl,
  }: {
    type: string;
    typeToIconUrl: (type: string) => string | null;
  }) => {
    const iconUrl = typeToIconUrl(type);
    if (iconUrl) return <IconImg src={iconUrl} alt={type} />;
    return <DatabaseIcon size={24} strokeWidth={1.5} />;
  },
);
DatabaseTypeIcon.displayName = "DatabaseTypeIcon";

interface DatabaseExplorerProps {
  onCollectionSelect?: (
    databaseId: string,
    collectionName: string,
    collectionInfo: CollectionInfo,
  ) => void;
  onCollectionClick?: (databaseId: string, collection: CollectionInfo) => void;
}

function DatabaseExplorer({
  onCollectionSelect,
  onCollectionClick,
}: DatabaseExplorerProps) {
  const {
    databases: databasesMap,
    loading: loadingMap,
    refreshServers,
    initServers,
    deleteDatabase,
  } = useDatabaseStore();
  const {
    fetchRoot,
    fetchChildren,
    nodes,
    loading: treeLoading,
  } = useDatabaseTreeStore();

  const { currentWorkspace } = useWorkspace();

  // Don't subscribe to console store - it causes re-renders on every keystroke
  // Use getState() in handlers instead

  const databases = currentWorkspace
    ? databasesMap[currentWorkspace.id] || []
    : [];
  const loading = currentWorkspace ? !!loadingMap[currentWorkspace.id] : false;
  const { types: dbTypes, fetchTypes } = useDatabaseCatalogStore();

  useEffect(() => {
    fetchTypes().catch(() => undefined);
  }, [fetchTypes]);

  const typeToIconUrl = (type: string): string | null => {
    const meta = (dbTypes || []).find(t => t.type === type);
    return meta?.iconUrl || null;
  };
  const [loadingData, setLoadingData] = useState<Set<string>>(new Set());
  const error = currentWorkspace
    ? useDatabaseStore.getState().error[currentWorkspace.id]
    : null;

  const {
    expandedDatabases,
    toggleDatabase,
    isDatabaseExpanded,
    expandedNodes,
    toggleNode,
  } = useDatabaseExplorerStore();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingDatabaseId, setEditingDatabaseId] = useState<
    string | undefined
  >(undefined);

  const refreshDatabasesLocal = async () => {
    if (!currentWorkspace) return;
    await refreshServers(currentWorkspace.id);
  };

  useEffect(() => {
    if (currentWorkspace) {
      initServers(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id]);

  const fetchDatabaseDataLocal = async (databaseId: string) => {
    if (!currentWorkspace) return;
    setLoadingData(prev => new Set(prev).add(databaseId));
    await fetchRoot(currentWorkspace.id, databaseId);
    setLoadingData(prev => {
      const next = new Set(prev);
      next.delete(databaseId);
      return next;
    });
  };

  useEffect(() => {
    if (!currentWorkspace) return;
    databases.forEach(db => {
      const hasNodes = nodes[db.id] && nodes[db.id]["root"];
      if (!hasNodes) {
        fetchDatabaseDataLocal(db.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, currentWorkspace?.id]);

  const handleDatabaseToggle = (databaseId: string) => {
    toggleDatabase(databaseId);
    const hasNodes = nodes[databaseId] && nodes[databaseId]["root"];
    if (!isDatabaseExpanded(databaseId) && !hasNodes) {
      fetchDatabaseDataLocal(databaseId);
    }
  };

  const handleCollectionClick = (
    databaseId: string,
    collection: CollectionInfo,
  ) => {
    onCollectionSelect?.(databaseId, collection.name, collection);
    onCollectionClick?.(databaseId, collection);
  };

  const handleRefresh = () => {
    setLoadingData(new Set());
    refreshDatabasesLocal();
  };

  const handleDatabaseCreated = () => {
    handleRefresh();
  };

  const renderSkeletonItems = () => {
    return Array.from({ length: 3 }).map((_, index) => (
      <ListItem key={`skeleton-${index}`} disablePadding>
        <ListItemButton sx={{ py: 0.5, pl: 1 }}>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <Skeleton variant="circular" width={20} height={20} />
          </ListItemIcon>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <Skeleton variant="circular" width={24} height={24} />
          </ListItemIcon>
          <ListItemText
            primary={
              <Skeleton
                variant="text"
                width={`${60 + Math.random() * 40}%`}
                height={20}
              />
            }
          />
        </ListItemButton>
      </ListItem>
    ));
  };

  const renderCollectionSkeletonItems = () => {
    return Array.from({ length: 3 }).map((_, index) => (
      <ListItem key={`collection-skeleton-${index}`} disablePadding>
        <ListItemButton sx={{ py: 0.25, pl: 4 }}>
          <ListItemIcon sx={{ minWidth: 24 }}>
            <Skeleton variant="circular" width={16} height={16} />
          </ListItemIcon>
          <ListItemText
            primary={
              <Skeleton
                variant="text"
                width={`${50 + Math.random() * 30}%`}
                height={16}
              />
            }
          />
        </ListItemButton>
      </ListItem>
    ));
  };

  const renderNodeSkeleton = (level: number) => {
    // level is parent level. We are rendering children at level + 1
    // Formula: 1 + (level + 1) * 1.5 + 2.75 (assuming skeleton mimics leaf)
    const pl = 1 + (level + 1) * 1.5 + 2.75;
    return Array.from({ length: 3 }).map((_, index) => (
      <ListItem key={`node-skeleton-${index}`} disablePadding>
        <ListItemButton sx={{ py: 0.25, pl }}>
          <ListItemIcon sx={{ minWidth: 28 }}>
            <Skeleton variant="circular" width={16} height={16} />
          </ListItemIcon>
          <ListItemText
            primary={
              <Skeleton
                variant="text"
                width={`${50 + Math.random() * 30}%`}
                height={16}
              />
            }
          />
        </ListItemButton>
      </ListItem>
    ));
  };

  // ---------------- Context menu for databases ----------------
  const [databaseContextMenu, setDatabaseContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: { databaseId: string; databaseName: string };
  } | null>(null);

  const handleDatabaseContextMenu = (
    event: React.MouseEvent,
    databaseId: string,
    databaseName: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDatabaseContextMenu(
      contextMenu === null
        ? {
            mouseX: event.clientX + 2,
            mouseY: event.clientY - 6,
            item: { databaseId, databaseName },
          }
        : null,
    );
  };

  const handleEditDatabase = () => {
    if (!databaseContextMenu) return;
    const { databaseId } = databaseContextMenu.item;
    setEditingDatabaseId(databaseId);
    setCreateDialogOpen(true);
    setDatabaseContextMenu(null);
  };

  const handleDropDatabase = async () => {
    if (!databaseContextMenu) return;
    const { databaseId, databaseName } = databaseContextMenu.item;

    if (
      !window.confirm(
        `Are you sure you want to delete database "${databaseName}"? This action cannot be undone.`,
      )
    ) {
      setDatabaseContextMenu(null);
      return;
    }

    try {
      if (currentWorkspace) {
        await deleteDatabase(currentWorkspace.id, databaseId);
      }
    } catch (error: any) {
      alert(error.message || "Failed to delete database");
    } finally {
      setDatabaseContextMenu(null);
    }
  };

  // ---------------- Context menu for collections ----------------
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: { databaseId: string; collectionName: string };
  } | null>(null);

  const handleDropCollection = () => {
    if (!contextMenu) return;
    const { databaseId, collectionName } = contextMenu.item;
    const command = `db.getCollection("${collectionName}").drop()`;
    const { addConsoleTab, setActiveConsole } = useConsoleStore.getState();
    const tabId = addConsoleTab({
      title: `Drop ${collectionName}`,
      content: command,
      initialContent: command,
      databaseId,
    });
    setActiveConsole(tabId);
    setContextMenu(null);
  };

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
        <Box sx={{ textAlign: "center" }}>
          <IconButton onClick={handleRefresh} color="primary">
            <RefreshIcon />
          </IconButton>
        </Box>
      </Box>
    );
  }

  const renderNode = (
    databaseId: string,
    node: TreeNode,
    level: number,
  ): React.ReactNode => {
    const nodeKey = `${databaseId}:${node.kind}:${node.id}`;
    const isExpanded = expandedNodes.has(nodeKey);
    const childKey = `${node.kind}:${node.id}`;
    const children = nodes[databaseId]?.[childKey];
    const isLoading = treeLoading[`${databaseId}:${childKey}`];

    const getIcon = () => {
      switch (node.kind) {
        case "dataset":
        case "group":
        case "schema":
          return isExpanded ? (
            <FolderOpenIcon size={18} strokeWidth={1.5} />
          ) : (
            <FolderIcon size={18} strokeWidth={1.5} />
          );
        case "database":
          return <LayersIcon size={18} strokeWidth={1.5} />;
        case "table":
        case "collection":
          return <CollectionIcon size={18} strokeWidth={1.5} />;
        case "view":
          return <ViewIcon size={18} strokeWidth={1.5} />;
        default:
          return null;
      }
    };

    return (
      <React.Fragment key={nodeKey}>
        <ListItem disablePadding>
          <ListItemButton
            onClick={() => {
              if (node.hasChildren) {
                toggleNode(nodeKey);
                if (!children && !isExpanded) {
                  if (currentWorkspace) {
                    fetchChildren(currentWorkspace.id, databaseId, node);
                  }
                }
              } else {
                handleCollectionClick(databaseId, {
                  name: node.id,
                  type: node.kind,
                  options: node.metadata,
                } as any);
              }
            }}
            sx={{
              py: 0.25,
              pl: 1 + level * 1.5,
            }}
          >
            <ListItemIcon sx={{ minWidth: 22 }}>
              {node.hasChildren ? (
                isExpanded ? (
                  <ChevronDownIcon strokeWidth={1.5} size={20} />
                ) : (
                  <ChevronRightIcon strokeWidth={1.5} size={20} />
                )
              ) : null}
            </ListItemIcon>
            <ListItemIcon sx={{ minWidth: 24 }}>{getIcon()}</ListItemIcon>
            <ListItemText
              primary={
                <Typography
                  variant="body2"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.label}
                </Typography>
              }
            />
          </ListItemButton>
        </ListItem>
        {node.hasChildren && isExpanded && (
          <List dense disablePadding>
            {isLoading || (!children && isExpanded) ? (
              renderNodeSkeleton(level)
            ) : children && children.length === 0 ? (
              <ListItem disablePadding sx={{ pl: 4 + (level + 1) * 2 }}>
                <ListItemText
                  secondary={
                    <Typography variant="caption" color="text.secondary">
                      Empty
                    </Typography>
                  }
                />
              </ListItem>
            ) : (
              children?.map(child => renderNode(databaseId, child, level + 1))
            )}
          </List>
        )}
      </React.Fragment>
    );
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Box
            sx={{
              flexGrow: 1,
              overflow: "hidden",
              maxWidth: "calc(100% - 80px)",
            }}
          >
            <Typography
              variant="h6"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}
            >
              Databases
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="Add new database">
              <IconButton
                size="small"
                onClick={() => setCreateDialogOpen(true)}
              >
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton size="small" onClick={handleRefresh}>
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        <List dense>
          {loading ? (
            renderSkeletonItems()
          ) : databases.length === 0 ? (
            <Box
              sx={{
                p: 3,
                textAlign: "center",
                color: "text.secondary",
              }}
            >
              <Typography variant="body2">
                No databases found in configuration
              </Typography>
            </Box>
          ) : (
            databases.map(database => {
              const isDatabaseExpanded = expandedDatabases.has(database.id);
              const isLoadingData = loadingData.has(database.id);
              const dbRootNodes: TreeNode[] =
                nodes[database.id]?.["root"] || [];

              return (
                <React.Fragment key={database.id}>
                  {/* Database Level */}
                  <ListItem disablePadding>
                    <ListItemButton
                      onClick={() => handleDatabaseToggle(database.id)}
                      onContextMenu={e =>
                        handleDatabaseContextMenu(
                          e,
                          database.id,
                          database.displayName,
                        )
                      }
                      sx={{ py: 0.5, pl: 1 }}
                    >
                      <ListItemIcon sx={{ minWidth: 22 }}>
                        {isDatabaseExpanded ? (
                          <ChevronDownIcon strokeWidth={1.5} size={20} />
                        ) : (
                          <ChevronRightIcon strokeWidth={1.5} size={20} />
                        )}
                      </ListItemIcon>
                      <ListItemIcon sx={{ minWidth: 24 }}>
                        <DatabaseTypeIcon
                          type={database.type}
                          typeToIconUrl={typeToIconUrl}
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 1,
                              overflow: "hidden",
                            }}
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {database.displayName}
                            </Typography>
                          </Box>
                        }
                      />
                    </ListItemButton>
                  </ListItem>

                  {isDatabaseExpanded && (
                    <List dense disablePadding>
                      {isLoadingData
                        ? renderCollectionSkeletonItems()
                        : dbRootNodes.map(node =>
                            renderNode(database.id, node, 1),
                          )}
                    </List>
                  )}
                </React.Fragment>
              );
            })
          )}
        </List>
      </Box>

      <CreateDatabaseDialog
        open={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
          setEditingDatabaseId(undefined);
        }}
        onSuccess={handleDatabaseCreated}
        databaseId={editingDatabaseId}
      />

      {/* Context Menu for collection */}
      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
        PaperProps={{
          elevation: 2,
          sx: {
            boxShadow: "0px 2px 4px rgba(0,0,0,0.12)",
            minWidth: 180,
          },
        }}
      >
        <MenuItem
          onClick={handleDropCollection}
          sx={{
            pl: 1,
            pr: 1,
            "& .MuiListItemIcon-root": {
              minWidth: 26,
            },
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={18} strokeWidth={1.5} />
          </ListItemIcon>
          Delete collection
        </MenuItem>
      </Menu>

      {/* Context Menu for database */}
      <Menu
        open={databaseContextMenu !== null}
        onClose={() => setDatabaseContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          databaseContextMenu !== null
            ? {
                top: databaseContextMenu.mouseY,
                left: databaseContextMenu.mouseX,
              }
            : undefined
        }
        PaperProps={{
          elevation: 2,
          sx: {
            boxShadow: "0px 2px 4px rgba(0,0,0,0.12)",
            minWidth: 180,
          },
        }}
      >
        <MenuItem
          onClick={handleEditDatabase}
          sx={{
            pl: 1,
            pr: 1,
            "& .MuiListItemIcon-root": {
              minWidth: 26,
            },
          }}
        >
          <ListItemIcon>
            <SettingsIcon size={18} strokeWidth={1.5} />
          </ListItemIcon>
          Edit connection
        </MenuItem>
        <MenuItem
          onClick={handleDropDatabase}
          sx={{
            pl: 1,
            pr: 1,
            "& .MuiListItemIcon-root": {
              minWidth: 26,
            },
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={18} strokeWidth={1.5} />
          </ListItemIcon>
          Delete database
        </MenuItem>
      </Menu>
    </Box>
  );
}

export default React.memo(DatabaseExplorer);
