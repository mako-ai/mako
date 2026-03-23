import React, { useState, useEffect, useCallback, useMemo } from "react";
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
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  FormControl,
  InputLabel,
  Select,
  type SelectChangeEvent,
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
  Share2 as ShareIcon,
  Lock as LockIcon,
} from "lucide-react";
import { useDatabaseExplorerStore } from "../store";
import { useWorkspace } from "../contexts/workspace-context";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import {
  useSchemaStore,
  Connection,
  TreeNode,
  DatabaseAccessLevel,
} from "../store/schemaStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useConsoleStore } from "../store/consoleStore";

// For backward compatibility with existing props
export interface CollectionInfo {
  name: string;
  type: string;
  options: unknown;
}

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

const AccessBadge = React.memo(
  ({
    access,
    isOwner,
  }: {
    access?: DatabaseAccessLevel;
    isOwner?: boolean;
  }) => {
    if (!access || access === "shared_write") return null;
    if (access === "private") {
      return (
        <Tooltip title="Private">
          <LockIcon
            size={14}
            strokeWidth={1.5}
            style={{ opacity: 0.6, flexShrink: 0 }}
          />
        </Tooltip>
      );
    }
    if (access === "shared_read" && !isOwner) {
      return (
        <Chip
          label="read-only"
          size="small"
          variant="outlined"
          sx={{ height: 18, fontSize: "0.65rem", flexShrink: 0 }}
        />
      );
    }
    return null;
  },
);
AccessBadge.displayName = "AccessBadge";

function ShareDatabaseDialog({
  open,
  database,
  onClose,
  workspaceId,
}: {
  open: boolean;
  database: Connection | null;
  onClose: () => void;
  workspaceId: string;
}) {
  const shareDatabase = useSchemaStore(s => s.shareDatabase);
  const [accessLevel, setAccessLevel] = useState<DatabaseAccessLevel>(
    database?.access || "shared_write",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (database?.access) setAccessLevel(database.access);
  }, [database?.access]);

  const handleSave = async () => {
    if (!database) return;
    setSaving(true);
    await shareDatabase(workspaceId, database.id, { access: accessLevel });
    setSaving(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Share Settings</DialogTitle>
      <DialogContent>
        <FormControl fullWidth sx={{ mt: 1 }}>
          <InputLabel>Access Level</InputLabel>
          <Select
            value={accessLevel}
            label="Access Level"
            onChange={(e: SelectChangeEvent) =>
              setAccessLevel(e.target.value as DatabaseAccessLevel)
            }
          >
            <MenuItem value="shared_write">Shared (read &amp; write)</MenuItem>
            <MenuItem value="shared_read">Shared (read-only)</MenuItem>
            <MenuItem value="private">Private (only me)</MenuItem>
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

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
  // Use the unified schema store
  const connections = useSchemaStore(s => s.connections);
  const treeNodes = useSchemaStore(s => s.treeNodes);
  const loading = useSchemaStore(s => s.loading);
  const error = useSchemaStore(s => s.error);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);
  const ensureTreeRoot = useSchemaStore(s => s.ensureTreeRoot);
  const ensureTreeChildren = useSchemaStore(s => s.ensureTreeChildren);
  const refreshConnections = useSchemaStore(s => s.refreshConnections);
  const deleteConnection = useSchemaStore(s => s.deleteConnection);

  const { currentWorkspace } = useWorkspace();

  const databases: Connection[] = currentWorkspace
    ? connections[currentWorkspace.id] || []
    : [];

  const isLoadingConnections = currentWorkspace
    ? !!loading[`connections:${currentWorkspace.id}`]
    : false;

  const connectionError = currentWorkspace
    ? error[`connections:${currentWorkspace.id}`]
    : null;

  const { types: dbTypes, fetchTypes } = useDatabaseCatalogStore();

  useEffect(() => {
    fetchTypes().catch(() => undefined);
  }, [fetchTypes]);

  const typeToIconUrl = useCallback(
    (type: string): string | null => {
      const meta = (dbTypes || []).find(t => t.type === type);
      return meta?.iconUrl || null;
    },
    [dbTypes],
  );

  const [loadingData, setLoadingData] = useState<Set<string>>(new Set());

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
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sharingDatabase, setSharingDatabase] = useState<Connection | null>(
    null,
  );

  const myDatabases = useMemo(
    () => databases.filter(db => db.isOwner === true),
    [databases],
  );
  const sharedDatabases = useMemo(
    () => databases.filter(db => db.isOwner !== true),
    [databases],
  );

  // Initialize connections on mount
  useEffect(() => {
    if (currentWorkspace) {
      ensureConnections(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, ensureConnections]);

  // Fetch tree roots for all databases
  const fetchDatabaseDataLocal = useCallback(
    async (connectionId: string) => {
      if (!currentWorkspace) return;
      setLoadingData(prev => new Set(prev).add(connectionId));
      await ensureTreeRoot(currentWorkspace.id, connectionId);
      setLoadingData(prev => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    },
    [currentWorkspace, ensureTreeRoot],
  );

  useEffect(() => {
    if (!currentWorkspace) return;
    databases.forEach(db => {
      const hasNodes = treeNodes[db.id] && treeNodes[db.id]["root"];
      if (!hasNodes) {
        fetchDatabaseDataLocal(db.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, currentWorkspace?.id, treeNodes, fetchDatabaseDataLocal]);

  // Re-fetch children for expanded nodes that lost their data (e.g., after refresh)
  useEffect(() => {
    if (!currentWorkspace) return;

    databases.forEach(db => {
      if (!isDatabaseExpanded(db.id)) return;

      const dbTree = treeNodes[db.id];
      if (!dbTree) return;

      const rootNodes = dbTree["root"] || [];

      const checkAndFetchMissingChildren = (node: TreeNode) => {
        const nodeKey = `${db.id}:${node.kind}:${node.id}`;
        if (!node.hasChildren || !expandedNodes.has(nodeKey)) return;

        const childKey = `${node.kind}:${node.id}`;
        const children = dbTree[childKey];

        if (!children) {
          // Expanded node with missing children - fetch them
          ensureTreeChildren(currentWorkspace.id, db.id, {
            id: node.id,
            kind: node.kind,
            metadata: node.metadata,
          });
        } else {
          // Recurse into existing children
          children.forEach(checkAndFetchMissingChildren);
        }
      };

      rootNodes.forEach(checkAndFetchMissingChildren);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentWorkspace?.id,
    databases,
    treeNodes,
    expandedNodes,
    isDatabaseExpanded,
    ensureTreeChildren,
  ]);

  const handleDatabaseToggle = useCallback(
    (connectionId: string) => {
      toggleDatabase(connectionId);
      const hasNodes =
        treeNodes[connectionId] && treeNodes[connectionId]["root"];
      if (!isDatabaseExpanded(connectionId) && !hasNodes) {
        fetchDatabaseDataLocal(connectionId);
      }
    },
    [toggleDatabase, treeNodes, isDatabaseExpanded, fetchDatabaseDataLocal],
  );

  const handleCollectionClick = useCallback(
    (connectionId: string, collection: CollectionInfo) => {
      onCollectionSelect?.(connectionId, collection.name, collection);
      onCollectionClick?.(connectionId, collection);
    },
    [onCollectionSelect, onCollectionClick],
  );

  const handleRefresh = useCallback(async () => {
    if (!currentWorkspace) return;
    setLoadingData(new Set());
    await refreshConnections(currentWorkspace.id);
  }, [currentWorkspace, refreshConnections]);

  const handleDatabaseCreated = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

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

  // ---------------- Context menu for collections ----------------
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: { databaseId: string; collectionName: string };
  } | null>(null);

  const handleDatabaseContextMenu = useCallback(
    (event: React.MouseEvent, databaseId: string, databaseName: string) => {
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
    },
    [contextMenu],
  );

  const handleEditDatabase = useCallback(() => {
    if (!databaseContextMenu) return;
    const { databaseId } = databaseContextMenu.item;
    setEditingDatabaseId(databaseId);
    setCreateDialogOpen(true);
    setDatabaseContextMenu(null);
  }, [databaseContextMenu]);

  const handleDropDatabase = useCallback(async () => {
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
        await deleteConnection(currentWorkspace.id, databaseId);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to delete database";
      alert(message);
    } finally {
      setDatabaseContextMenu(null);
    }
  }, [databaseContextMenu, currentWorkspace, deleteConnection]);

  const handleShareDatabase = useCallback(() => {
    if (!databaseContextMenu) return;
    const db = databases.find(
      d => d.id === databaseContextMenu.item.databaseId,
    );
    if (db) {
      setSharingDatabase(db);
      setShareDialogOpen(true);
    }
    setDatabaseContextMenu(null);
  }, [databaseContextMenu, databases]);

  const handleDropCollection = useCallback(() => {
    if (!contextMenu) return;
    const { databaseId, collectionName } = contextMenu.item;
    const command = `db.getCollection("${collectionName}").drop()`;
    const { openTab, setActiveTab } = useConsoleStore.getState();
    const tabId = openTab({
      title: `Drop ${collectionName}`,
      content: command,
      databaseId,
    });
    setActiveTab(tabId);
    setContextMenu(null);
  }, [contextMenu]);

  if (connectionError) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {connectionError}
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
    connectionId: string,
    node: TreeNode,
    level: number,
  ): React.ReactNode => {
    const nodeKey = `${connectionId}:${node.kind}:${node.id}`;
    const isExpanded = expandedNodes.has(nodeKey);
    const childKey = `${node.kind}:${node.id}`;
    const children = treeNodes[connectionId]?.[childKey];
    const isLoading = loading[`tree:${connectionId}:${childKey}`];

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
                    ensureTreeChildren(currentWorkspace.id, connectionId, {
                      id: node.id,
                      kind: node.kind,
                      metadata: node.metadata,
                    });
                  }
                }
              } else {
                handleCollectionClick(connectionId, {
                  name: node.label,
                  type: node.kind,
                  options: node.metadata,
                });
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
              children?.map(child => renderNode(connectionId, child, level + 1))
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
          {isLoadingConnections ? (
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
            (() => {
              const renderDatabaseItem = (database: Connection) => {
                const isDatabaseExpandedLocal = expandedDatabases.has(
                  database.id,
                );
                const isLoadingData = loadingData.has(database.id);
                const dbRootNodes: TreeNode[] =
                  treeNodes[database.id]?.["root"] || [];

                return (
                  <React.Fragment key={database.id}>
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
                          {isDatabaseExpandedLocal ? (
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
                                gap: 0.5,
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
                              <AccessBadge
                                access={database.access}
                                isOwner={database.isOwner}
                              />
                            </Box>
                          }
                        />
                      </ListItemButton>
                    </ListItem>

                    {isDatabaseExpandedLocal && (
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
              };

              const showSections =
                myDatabases.length > 0 && sharedDatabases.length > 0;

              if (!showSections) {
                return databases.map(renderDatabaseItem);
              }

              return (
                <>
                  {myDatabases.length > 0 && (
                    <>
                      <ListItem sx={{ py: 0.25 }}>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            fontSize: "0.65rem",
                            letterSpacing: "0.05em",
                          }}
                        >
                          My Databases
                        </Typography>
                      </ListItem>
                      {myDatabases.map(renderDatabaseItem)}
                    </>
                  )}
                  {sharedDatabases.length > 0 && (
                    <>
                      <ListItem sx={{ py: 0.25, mt: 0.5 }}>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            fontSize: "0.65rem",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Shared with me
                        </Typography>
                      </ListItem>
                      {sharedDatabases.map(renderDatabaseItem)}
                    </>
                  )}
                </>
              );
            })()
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
      {(() => {
        const contextDb = databaseContextMenu
          ? databases.find(d => d.id === databaseContextMenu.item.databaseId)
          : null;
        const canManageCtx = contextDb?.canManage === true;

        return (
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
            {canManageCtx && (
              <MenuItem
                onClick={handleEditDatabase}
                sx={{
                  pl: 1,
                  pr: 1,
                  "& .MuiListItemIcon-root": { minWidth: 26 },
                }}
              >
                <ListItemIcon>
                  <SettingsIcon size={18} strokeWidth={1.5} />
                </ListItemIcon>
                Edit connection
              </MenuItem>
            )}
            {canManageCtx && (
              <MenuItem
                onClick={handleShareDatabase}
                sx={{
                  pl: 1,
                  pr: 1,
                  "& .MuiListItemIcon-root": { minWidth: 26 },
                }}
              >
                <ListItemIcon>
                  <ShareIcon size={18} strokeWidth={1.5} />
                </ListItemIcon>
                Share settings
              </MenuItem>
            )}
            {canManageCtx && (
              <MenuItem
                onClick={handleDropDatabase}
                sx={{
                  pl: 1,
                  pr: 1,
                  "& .MuiListItemIcon-root": { minWidth: 26 },
                }}
              >
                <ListItemIcon>
                  <DeleteIcon size={18} strokeWidth={1.5} />
                </ListItemIcon>
                Delete database
              </MenuItem>
            )}
          </Menu>
        );
      })()}

      {currentWorkspace && (
        <ShareDatabaseDialog
          open={shareDialogOpen}
          database={sharingDatabase}
          onClose={() => {
            setShareDialogOpen(false);
            setSharingDatabase(null);
          }}
          workspaceId={currentWorkspace.id}
        />
      )}
    </Box>
  );
}

export default React.memo(DatabaseExplorer);
