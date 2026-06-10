import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Alert,
  IconButton,
  Skeleton,
  MenuItem,
  ListItemIcon,
  Tooltip,
} from "@mui/material";
import {
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
  Columns3 as ColumnIcon,
  KeyRound as KeyIcon,
  Type as StringIcon,
  Hash as NumberIcon,
  ToggleLeft as BooleanIcon,
  Calendar as DateTimeIcon,
  Braces as JsonIcon,
  Brackets as ArrayIcon,
  Fingerprint as UuidIcon,
  Binary as BinaryIcon,
  ListOrdered as IndexIcon,
  Zap as TriggerIcon,
} from "lucide-react";
import { useExplorerStore } from "../store";
import { useWorkspace } from "../contexts/workspace-context";
import CreateDatabaseDialog from "./CreateDatabaseDialog";
import { useSchemaStore, Connection, TreeNode } from "../store/schemaStore";
import { useLocalAgentStore } from "../store/localAgentStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useConsoleStore } from "../store/consoleStore";
import ResourceTree, {
  type ResourceTreeNode,
  type ResourceTreeSection,
} from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

export interface CollectionInfo {
  name: string;
  type: string;
  options: unknown;
}

const PRIMARY_KEY_COLOR = "#d4a017";

/** Connection types whose tables open the paginated data view on click. */
const POSTGRES_FAMILY_TYPES = new Set([
  "postgresql",
  "cloudsql-postgres",
  "redshift",
]);

/** Pick an icon for a column based on its (Postgres) data type. */
function columnTypeIcon(columnType: unknown): React.ReactNode {
  const t = String(columnType || "").toLowerCase();
  const props = { size: 15, strokeWidth: 1.5 };
  if (t.endsWith("[]")) return <ArrayIcon {...props} />;
  if (t.includes("uuid")) return <UuidIcon {...props} />;
  if (t.includes("bool")) return <BooleanIcon {...props} />;
  if (t.includes("json")) return <JsonIcon {...props} />;
  if (/timestamp|date|time|interval/.test(t)) {
    return <DateTimeIcon {...props} />;
  }
  if (/int|serial|numeric|decimal|real|double|float|money/.test(t)) {
    return <NumberIcon {...props} />;
  }
  if (/char|text|citext|name|string/.test(t)) return <StringIcon {...props} />;
  if (/bytea|binary|blob/.test(t)) return <BinaryIcon {...props} />;
  return <ColumnIcon {...props} />;
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
    return <DatabaseIcon size={20} strokeWidth={1.5} />;
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

// Lookup info stashed alongside each ResourceTreeNode so the lazy-load /
// context-menu callbacks can recover the original TreeNode + connection.
type DbNodeInfo =
  | {
      type: "connection";
      connectionId: string;
      displayName: string;
      dbType: string;
    }
  | {
      type: "node";
      connectionId: string;
      node: TreeNode;
    };

function DatabaseExplorer({
  onCollectionSelect,
  onCollectionClick,
}: DatabaseExplorerProps) {
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

  const databases: Connection[] = useMemo(
    () => (currentWorkspace ? connections[currentWorkspace.id] || [] : []),
    [currentWorkspace, connections],
  );

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

  const expandedDatabases = useExplorerStore(s => s.database.expandedDatabases);
  const expandedNodes = useExplorerStore(s => s.database.expandedNodes);
  const toggleDatabase = useExplorerStore(s => s.toggleDatabase);
  const toggleNode = useExplorerStore(s => s.toggleNode);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingDatabaseId, setEditingDatabaseId] = useState<
    string | undefined
  >(undefined);

  const ensureAgentChecked = useLocalAgentStore(s => s.ensureChecked);

  useEffect(() => {
    if (currentWorkspace) {
      // Detect the Mako Local Agent first so local connections are merged
      // into the explorer; ensureConnections itself tolerates agent absence.
      ensureAgentChecked()
        .catch(() => undefined)
        .finally(() => ensureConnections(currentWorkspace.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, ensureConnections, ensureAgentChecked]);

  useEffect(() => {
    if (!currentWorkspace) return;
    databases.forEach(db => {
      const hasNodes = treeNodes[db.id] && treeNodes[db.id]["root"];
      if (!hasNodes) {
        ensureTreeRoot(currentWorkspace.id, db.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, currentWorkspace?.id, treeNodes, ensureTreeRoot]);

  const handleRefresh = useCallback(async () => {
    if (!currentWorkspace) return;
    await refreshConnections(currentWorkspace.id);
  }, [currentWorkspace, refreshConnections]);

  const handleDatabaseCreated = useCallback(() => {
    handleRefresh();
  }, [handleRefresh]);

  const handleCollectionClick = useCallback(
    (connectionId: string, collection: CollectionInfo) => {
      onCollectionSelect?.(connectionId, collection.name, collection);
      onCollectionClick?.(connectionId, collection);
    },
    [onCollectionSelect, onCollectionClick],
  );

  // ---------- Tree adapter ----------

  // Build a lookup map and the section tree in one pass so callbacks can
  // recover original TreeNode data from ResourceTreeNode.id.
  const { sections, nodeInfoById } = useMemo(() => {
    const info = new Map<string, DbNodeInfo>();

    const makeConnectionNodeId = (dbId: string) => dbId;
    const makeTreeNodeId = (dbId: string, node: TreeNode) =>
      `${dbId}:${node.kind}:${node.id}`;

    const buildTreeNode = (
      connectionId: string,
      node: TreeNode,
    ): ResourceTreeNode => {
      const rtId = makeTreeNodeId(connectionId, node);
      info.set(rtId, { type: "node", connectionId, node });

      const childKey = `${node.kind}:${node.id}`;
      const rawChildren = treeNodes[connectionId]?.[childKey];

      const isDir = node.hasChildren === true;
      let children: ResourceTreeNode[] | undefined;
      if (isDir) {
        if (rawChildren === undefined) {
          children = undefined;
        } else {
          children = rawChildren.map(child =>
            buildTreeNode(connectionId, child),
          );
        }
      } else {
        children = undefined;
      }

      return {
        id: rtId,
        name: node.label,
        path: node.label,
        isDirectory: isDir,
        children,
      };
    };

    const connectionNodes: ResourceTreeNode[] = databases.map(db => {
      const rtId = makeConnectionNodeId(db.id);
      info.set(rtId, {
        type: "connection",
        connectionId: db.id,
        displayName: db.displayName,
        dbType: db.type,
      });

      const rawRoots = treeNodes[db.id]?.["root"];
      let children: ResourceTreeNode[] | undefined;
      if (rawRoots === undefined) {
        children = undefined;
      } else {
        children = rawRoots.map(n => buildTreeNode(db.id, n));
      }

      return {
        id: rtId,
        name: db.displayName,
        path: db.displayName,
        isDirectory: true,
        children,
      };
    });

    const sectionsList: ResourceTreeSection[] = [
      {
        key: "databases",
        label: "",
        hideSectionHeader: true,
        nodes: connectionNodes,
      },
    ];

    return { sections: sectionsList, nodeInfoById: info };
  }, [databases, treeNodes]);

  const isFolderExpanded = useCallback(
    (key: string) => {
      const info = nodeInfoById.get(key);
      if (!info) return false;
      if (info.type === "connection") {
        return !!expandedDatabases[info.connectionId];
      }
      // For non-connection nodes, expansion is tracked in expandedNodes under
      // the `${connectionId}:${kind}:${id}` key (which is the same as the
      // ResourceTreeNode id we've chosen).
      return !!expandedNodes[key];
    },
    [nodeInfoById, expandedDatabases, expandedNodes],
  );

  const onToggleFolder = useCallback(
    (key: string) => {
      const info = nodeInfoById.get(key);
      if (!info) return;
      if (info.type === "connection") {
        toggleDatabase(info.connectionId);
      } else {
        toggleNode(key);
      }
    },
    [nodeInfoById, toggleDatabase, toggleNode],
  );

  const onExpandFolder = useCallback(
    (key: string) => {
      const info = nodeInfoById.get(key);
      if (!info) return;
      if (info.type === "connection") {
        if (!expandedDatabases[info.connectionId]) {
          toggleDatabase(info.connectionId);
        }
      } else if (!expandedNodes[key]) {
        toggleNode(key);
      }
    },
    [
      nodeInfoById,
      expandedDatabases,
      toggleDatabase,
      expandedNodes,
      toggleNode,
    ],
  );

  const onLoadChildren = useCallback(
    (node: ResourceTreeNode) => {
      if (!currentWorkspace) return;
      const info = nodeInfoById.get(node.id);
      if (!info) return;
      if (info.type === "connection") {
        ensureTreeRoot(currentWorkspace.id, info.connectionId);
      } else {
        ensureTreeChildren(currentWorkspace.id, info.connectionId, {
          id: info.node.id,
          kind: info.node.kind,
          metadata: info.node.metadata,
        });
      }
    },
    [currentWorkspace, nodeInfoById, ensureTreeRoot, ensureTreeChildren],
  );

  const isLoadingChildren = useCallback(
    (node: ResourceTreeNode) => {
      const info = nodeInfoById.get(node.id);
      if (!info) return false;
      if (info.type === "connection") {
        return !!loading[`tree:${info.connectionId}:root`];
      }
      return !!loading[
        `tree:${info.connectionId}:${info.node.kind}:${info.node.id}`
      ];
    },
    [nodeInfoById, loading],
  );

  const getItemIcon = useCallback(
    (node: ResourceTreeNode, ctx?: { isExpanded: boolean }) => {
      const info = nodeInfoById.get(node.id);
      if (!info) return null;
      const iconEl = (() => {
        if (info.type === "connection") {
          return (
            <DatabaseTypeIcon
              type={info.dbType}
              typeToIconUrl={typeToIconUrl}
            />
          );
        }
        switch (info.node.kind) {
          case "dataset":
          case "group":
          case "schema":
            return ctx?.isExpanded ? (
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
          case "column":
            return info.node.metadata?.isPrimaryKey === true ? (
              <KeyIcon
                size={15}
                strokeWidth={1.75}
                style={{ color: PRIMARY_KEY_COLOR }}
              />
            ) : (
              columnTypeIcon(info.node.metadata?.columnType)
            );
          case "key":
            return (
              <KeyIcon
                size={15}
                strokeWidth={1.75}
                style={
                  info.node.metadata?.keyType === "PRIMARY KEY"
                    ? { color: PRIMARY_KEY_COLOR }
                    : undefined
                }
              />
            );
          case "index":
            return <IndexIcon size={15} strokeWidth={1.5} />;
          case "trigger":
            return <TriggerIcon size={15} strokeWidth={1.5} />;
          default:
            return null;
        }
      })();
      return iconEl;
    },
    [nodeInfoById, typeToIconUrl],
  );

  // Dimmed detail at the right edge of a row (DataGrip / TablePlus style):
  // column types, group counts, key/index/trigger info.
  const getRightAdornment = useCallback(
    (node: ResourceTreeNode) => {
      const info = nodeInfoById.get(node.id);
      if (!info || info.type !== "node") return null;
      const { kind, metadata } = info.node;

      let text: string | null = null;
      switch (kind) {
        case "column":
          text = metadata?.columnType ? String(metadata.columnType) : null;
          break;
        case "group":
          text = metadata?.count !== undefined ? String(metadata.count) : null;
          break;
        case "key":
          text = metadata?.keyType
            ? String(metadata.keyType).toLowerCase()
            : null;
          break;
        case "index": {
          const parts = [
            metadata?.isUnique ? "unique" : null,
            metadata?.method ? String(metadata.method) : null,
          ].filter(Boolean);
          text = parts.length > 0 ? parts.join(" ") : null;
          break;
        }
        case "trigger": {
          const parts = [
            metadata?.timing ? String(metadata.timing) : null,
            metadata?.events ? String(metadata.events) : null,
          ].filter(Boolean);
          text = parts.length > 0 ? parts.join(" ").toLowerCase() : null;
          break;
        }
        default:
          return null;
      }

      if (!text) return null;
      return (
        <Typography
          variant="caption"
          sx={{
            color: "text.disabled",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 110,
          }}
        >
          {text}
        </Typography>
      );
    },
    [nodeInfoById],
  );

  const getContextMenuItems = useCallback(
    (
      node: ResourceTreeNode,
      helpers: { closeMenu: () => void },
    ): React.ReactNode[] | null => {
      const info = nodeInfoById.get(node.id);
      if (!info) return null;

      if (info.type === "connection") {
        return [
          <MenuItem
            key="edit-connection"
            onClick={() => {
              helpers.closeMenu();
              setEditingDatabaseId(info.connectionId);
              setCreateDialogOpen(true);
            }}
          >
            <ListItemIcon sx={{ minWidth: 26 }}>
              <SettingsIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Edit connection
          </MenuItem>,
          <MenuItem
            key="delete-database"
            onClick={async () => {
              helpers.closeMenu();
              if (
                !window.confirm(
                  `Are you sure you want to delete database "${info.displayName}"? This action cannot be undone.`,
                )
              ) {
                return;
              }
              try {
                if (currentWorkspace) {
                  await deleteConnection(
                    currentWorkspace.id,
                    info.connectionId,
                  );
                }
              } catch (err: unknown) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "Failed to delete database";
                alert(message);
              }
            }}
          >
            <ListItemIcon sx={{ minWidth: 26 }}>
              <DeleteIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Delete database
          </MenuItem>,
        ];
      }

      // For node (table / collection / view / folder / etc.)
      const { node: treeNode, connectionId } = info;
      const isLeafCollection =
        !treeNode.hasChildren &&
        (treeNode.kind === "collection" || treeNode.kind === "table");
      if (!isLeafCollection) {
        return []; // no menu
      }
      return [
        <MenuItem
          key="drop-collection"
          onClick={() => {
            helpers.closeMenu();
            const command = `db.getCollection("${treeNode.label}").drop()`;
            const { openTab, setActiveTab } = useConsoleStore.getState();
            const tabId = openTab({
              title: `Drop ${treeNode.label}`,
              content: command,
              databaseId: connectionId,
            });
            setActiveTab(tabId);
          }}
        >
          <ListItemIcon sx={{ minWidth: 26 }}>
            <DeleteIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Delete collection
        </MenuItem>,
      ];
    },
    [nodeInfoById, currentWorkspace, deleteConnection],
  );

  const connectionTypeById = useMemo(() => {
    const map = new Map<string, string>();
    databases.forEach(db => map.set(db.id, db.type));
    return map;
  }, [databases]);

  const openTableDataTab = useCallback(
    (connectionId: string, treeNode: TreeNode) => {
      const schema = (treeNode.metadata?.schema as string) || "public";
      const table = (treeNode.metadata?.table as string) || treeNode.label;
      const databaseName = treeNode.metadata?.databaseName as
        | string
        | undefined;
      const databaseId = treeNode.metadata?.databaseId as string | undefined;

      const { tabs, openTab, setActiveTab } = useConsoleStore.getState();
      const existing = Object.values(tabs).find(
        t =>
          t.kind === "table-data" &&
          t.connectionId === connectionId &&
          t.metadata?.schema === schema &&
          t.metadata?.table === table &&
          (t.databaseName || undefined) === (databaseName || undefined),
      );
      if (existing) {
        setActiveTab(existing.id);
        return;
      }

      const id = openTab({
        title: table,
        content: "",
        kind: "table-data",
        connectionId,
        databaseId,
        databaseName,
        metadata: { schema, table },
      });
      setActiveTab(id);
    },
    [],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const info = nodeInfoById.get(node.id);
      if (!info || info.type !== "node") return;
      const { node: treeNode, connectionId } = info;

      // Schema-object leaves (columns, keys, indexes, triggers) are
      // informational only.
      if (
        treeNode.kind === "column" ||
        treeNode.kind === "key" ||
        treeNode.kind === "index" ||
        treeNode.kind === "trigger"
      ) {
        return;
      }

      // Postgres-family tables/views open the paginated data view.
      if (
        (treeNode.kind === "table" || treeNode.kind === "view") &&
        POSTGRES_FAMILY_TYPES.has(connectionTypeById.get(connectionId) || "")
      ) {
        openTableDataTab(connectionId, treeNode);
        return;
      }

      if (!treeNode.hasChildren) {
        handleCollectionClick(connectionId, {
          name: treeNode.label,
          type: treeNode.kind,
          options: treeNode.metadata,
        });
      }
    },
    [nodeInfoById, handleCollectionClick, connectionTypeById, openTableDataTab],
  );

  // Clicking a Postgres table/view *name* opens its data; the caret still
  // expands the schema sub-tree (columns / keys / indexes / triggers).
  const shouldFolderClickActivate = useCallback(
    (node: ResourceTreeNode) => {
      const info = nodeInfoById.get(node.id);
      if (!info || info.type !== "node") return false;
      const kind = info.node.kind;
      if (kind !== "table" && kind !== "view") return false;
      return POSTGRES_FAMILY_TYPES.has(
        connectionTypeById.get(info.connectionId) || "",
      );
    },
    [nodeInfoById, connectionTypeById],
  );

  const getFolderExpansionKey = useCallback(
    (node: ResourceTreeNode) => node.id,
    [],
  );

  const renderSkeletonItems = () => (
    <Box sx={{ p: 1 }}>
      {Array.from({ length: 3 }).map((_, index) => (
        <Box
          key={`skeleton-${index}`}
          sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}
        >
          <Skeleton variant="circular" width={20} height={20} />
          <Skeleton variant="circular" width={24} height={24} />
          <Skeleton
            variant="text"
            width={`${60 + Math.random() * 40}%`}
            height={20}
          />
        </Box>
      ))}
    </Box>
  );

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

  const actions = (
    <>
      <Tooltip title="Add new database">
        <IconButton size="small" onClick={() => setCreateDialogOpen(true)}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Databases"
        actions={actions}
        searchPlaceholder="Search databases..."
        loading={isLoadingConnections && databases.length === 0}
        skeleton={renderSkeletonItems()}
      >
        {({ searchQuery }) =>
          databases.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
              <Typography variant="body2">
                No databases found in configuration
              </Typography>
            </Box>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              getItemIcon={getItemIcon}
              getRightAdornment={getRightAdornment}
              isFolderExpanded={isFolderExpanded}
              onToggleFolder={onToggleFolder}
              onExpandFolder={onExpandFolder}
              getFolderExpansionKey={getFolderExpansionKey}
              onLoadChildren={onLoadChildren}
              isLoadingChildren={isLoadingChildren}
              getContextMenuItems={getContextMenuItems}
              onItemClick={handleItemClick}
              shouldFolderClickActivate={shouldFolderClickActivate}
            />
          )
        }
      </ExplorerShell>

      <CreateDatabaseDialog
        open={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
          setEditingDatabaseId(undefined);
        }}
        onSuccess={handleDatabaseCreated}
        databaseId={editingDatabaseId}
      />
    </>
  );
}

export default React.memo(DatabaseExplorer);
