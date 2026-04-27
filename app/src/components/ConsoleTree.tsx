import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Eye as EyeIcon, SquareTerminal as ConsoleIcon } from "lucide-react";
import { Box, Tooltip } from "@mui/material";
import { useExplorerStore } from "../store/explorerStore";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
} from "../store/consoleTreeStore";
import ResourceTree, {
  type CreatedFolderResult,
  type ResourceTreeNode,
  type ResourceTreeRef,
  type ResourceTreeSection,
} from "./ResourceTree";

export interface ConsoleTreeProps {
  mode: "sidebar" | "picker";

  onFileOpen?: (node: ConsoleEntry) => void;
  onFileClick?: (node: ConsoleEntry) => void;
  onLocationChange?: (
    folderId: string | null,
    section: "my" | "workspace",
  ) => void;
  selectedLocationId?: string | null;
  selectedSectionKey?: "my" | "workspace";
  initialFolderId?: string | null;
  initialSection?: "my" | "workspace";

  showFiles?: boolean;
  enableDragDrop?: boolean;

  enableDuplicate?: boolean;
  enableInfo?: boolean;
  enableDelete?: boolean;
  enableRename?: boolean;
  enableMove?: boolean;

  onMoveRequest?: (item: ConsoleEntry) => void;
  onInfoRequest?: (item: ConsoleEntry) => void;
  onFolderInfoRequest?: (item: ConsoleEntry) => void;
  onDeleteRequest?: (item: ConsoleEntry) => void;
  onSoftDelete?: (item: ConsoleEntry) => void;
  onDuplicate?: (item: ConsoleEntry) => void;
  onUndo?: () => void;

  searchQuery?: string;
}

export interface ConsoleTreeRef {
  createFolder: (
    parentId: string | null,
    access?: "private" | "workspace",
  ) => void;
}

function ConsoleTreeInner(
  {
    mode,
    onFileOpen,
    onFileClick,
    onLocationChange,
    selectedLocationId,
    selectedSectionKey,
    initialFolderId,
    initialSection,
    showFiles = true,
    enableDragDrop = true,
    enableDuplicate = false,
    enableInfo = false,
    enableDelete = true,
    enableRename = true,
    enableMove = false,
    onMoveRequest,
    onInfoRequest,
    onFolderInfoRequest,
    onDeleteRequest,
    onSoftDelete,
    onDuplicate,
    onUndo,
    searchQuery = "",
  }: ConsoleTreeProps,
  ref: React.Ref<ConsoleTreeRef>,
) {
  const { currentWorkspace, members } = useWorkspace();
  const { user } = useAuth();

  // Pull the workspace's connections and the catalog of database types so we
  // can render a database-specific icon per console (mysql / postgres /
  // bigquery…) instead of a generic terminal glyph.
  const connectionsMap = useSchemaStore(state => state.connections);
  const connections = useMemo(
    () => (currentWorkspace ? connectionsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, connectionsMap],
  );

  const dbTypes = useDatabaseCatalogStore(state => state.types);
  const fetchDbTypes = useDatabaseCatalogStore(state => state.fetchTypes);

  useEffect(() => {
    // `fetchTypes` is deduped + persisted internally, so this is cheap when
    // another component has already loaded the catalog.
    void fetchDbTypes();
  }, [fetchDbTypes]);

  const typeIconUrlByConnectionId = useMemo(() => {
    const iconByType = new Map<string, string>();
    for (const t of dbTypes ?? []) {
      if (t.iconUrl) iconByType.set(t.type, t.iconUrl);
    }
    const byConnection = new Map<string, string>();
    for (const conn of connections) {
      const url = iconByType.get(conn.type);
      if (url) byConnection.set(conn.id, url);
    }
    return byConnection;
  }, [connections, dbTypes]);

  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const renameItem = useConsoleTreeStore(state => state.renameItem);
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);
  const createFolder = useConsoleTreeStore(state => state.createFolder);
  const resortItem = useConsoleTreeStore(state => state.resortItem);

  const activeTabId = useConsoleStore(state => state.activeTabId);

  const storeExpandedFolders = useExplorerStore(
    state => state.console.expandedFolders,
  );
  const storeToggleFolder = useExplorerStore(state => state.toggleFolder);
  const storeExpandFolder = useExplorerStore(state => state.expandFolder);

  const [localExpandedFolders, setLocalExpandedFolders] = useState<Set<string>>(
    () => new Set(Object.keys(storeExpandedFolders)),
  );

  const isFolderExpandedLocal = useCallback(
    (key: string): boolean => {
      if (mode === "sidebar") {
        return !!storeExpandedFolders[key];
      }
      return localExpandedFolders.has(key);
    },
    [mode, storeExpandedFolders, localExpandedFolders],
  );

  const toggleFolder = useCallback(
    (path: string) => {
      if (mode === "sidebar") {
        storeToggleFolder(path);
        return;
      }

      setLocalExpandedFolders(prev => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [mode, storeToggleFolder],
  );

  const expandFolder = useCallback(
    (path: string) => {
      if (mode === "sidebar") {
        storeExpandFolder(path);
        return;
      }

      setLocalExpandedFolders(prev => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [mode, storeExpandFolder],
  );

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const sharedWithWorkspace = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];

  const isOwner = useCallback(
    (item: ConsoleEntry) => item.owner_id === user?.id,
    [user?.id],
  );

  const canManage = useCallback(
    (item: ConsoleEntry) => {
      if (isOwner(item)) return true;
      const myRole = members.find(member => member.userId === user?.id)?.role;
      return myRole === "owner" || myRole === "admin";
    },
    [isOwner, members, user?.id],
  );

  const getItemIcon = useCallback(
    (node: ConsoleEntry) => {
      const iconUrl = node.connectionId
        ? typeIconUrlByConnectionId.get(node.connectionId)
        : undefined;

      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
          {iconUrl ? (
            <Box
              component="img"
              src={iconUrl}
              alt=""
              sx={{
                width: 16,
                height: 16,
                display: "block",
                flexShrink: 0,
                // Images render via the page — avoid dragging the asset when
                // the row is part of a DnD gesture.
                pointerEvents: "none",
                userSelect: "none",
              }}
              draggable={false}
            />
          ) : (
            // Fallback when a console has no connection yet, or the catalog
            // hasn't loaded / doesn't know this type.
            <ConsoleIcon size={16} strokeWidth={1.5} />
          )}
          {!node.isDirectory &&
            !isOwner(node) &&
            (node.access || "private") === "workspace" && (
              <Tooltip title="Read-only">
                <EyeIcon
                  size={14}
                  strokeWidth={1.5}
                  style={{ opacity: 0.5, flexShrink: 0 }}
                />
              </Tooltip>
            )}
        </Box>
      );
    },
    [isOwner, typeIconUrlByConnectionId],
  );

  const handleLocationChange = useCallback(
    (folderId: string | null, sectionKey: string) => {
      if (sectionKey === "my" || sectionKey === "workspace") {
        onLocationChange?.(folderId, sectionKey);
      }
    },
    [onLocationChange],
  );

  const handleMoveItem = useCallback(
    (itemId: string, targetFolderId: string | null, access?: string) => {
      if (!currentWorkspace) return;
      void moveConsole(
        currentWorkspace.id,
        itemId,
        targetFolderId,
        (access as "private" | "workspace" | undefined) ?? undefined,
      );
    },
    [currentWorkspace, moveConsole],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, parentId: string | null, access?: string) => {
      if (!currentWorkspace) return;
      void moveFolder(
        currentWorkspace.id,
        folderId,
        parentId,
        (access as "private" | "workspace" | undefined) ?? undefined,
      );
    },
    [currentWorkspace, moveFolder],
  );

  const handleRenameItem = useCallback(
    (id: string, name: string, isDirectory: boolean) => {
      if (!currentWorkspace) return;
      void renameItem(currentWorkspace.id, id, name, isDirectory);
    },
    [currentWorkspace, renameItem],
  );

  const handleDeleteItem = useCallback(
    async (node: ResourceTreeNode) => {
      if (!currentWorkspace) return;
      const consoleNode = node as ConsoleEntry;

      if (mode === "sidebar") {
        if (consoleNode.isDirectory) {
          onDeleteRequest?.(consoleNode);
        } else {
          onSoftDelete?.(consoleNode);
        }
        return;
      }

      if (!consoleNode.id) return;
      await deleteItem(
        currentWorkspace.id,
        consoleNode.id,
        consoleNode.isDirectory,
      );
    },
    [currentWorkspace, deleteItem, mode, onDeleteRequest, onSoftDelete],
  );

  const handleCreateFolder = useCallback(
    async (
      parentId: string | null,
      access?: string,
    ): Promise<CreatedFolderResult | null> => {
      if (!currentWorkspace) return null;
      return createFolder(
        currentWorkspace.id,
        "New Folder",
        parentId,
        (access as "private" | "workspace" | undefined) ?? undefined,
      );
    },
    [createFolder, currentWorkspace],
  );

  const sections = [
    {
      key: "my",
      label: "My Consoles",
      nodes: myConsoles as ResourceTreeNode[],
      droppableId: enableDragDrop ? "__section_my" : undefined,
      defaultAccess: "private" as const,
    },
    {
      key: "workspace",
      label: "Workspace",
      nodes: sharedWithWorkspace as ResourceTreeNode[],
      droppableId: enableDragDrop ? "__section_workspace" : undefined,
      defaultAccess: "workspace" as const,
    },
  ] satisfies ResourceTreeSection[];

  const resourceTreeRef = useRef<ResourceTreeRef | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      createFolder: (parentId, access) => {
        void resourceTreeRef.current?.createFolder(parentId, access);
      },
    }),
    [],
  );

  const handleResourceItemClick = useCallback(
    (node: ResourceTreeNode) => onFileOpen?.(node as ConsoleEntry),
    [onFileOpen],
  );
  const handlePickerFileClick = useCallback(
    (node: ResourceTreeNode) => onFileClick?.(node as ConsoleEntry),
    [onFileClick],
  );
  const handleDuplicateItem = useCallback(
    (node: ResourceTreeNode) => onDuplicate?.(node as ConsoleEntry),
    [onDuplicate],
  );
  const handleInfoRequest = useCallback(
    (node: ResourceTreeNode) => onInfoRequest?.(node as ConsoleEntry),
    [onInfoRequest],
  );
  const handleFolderInfoRequest = useCallback(
    (node: ResourceTreeNode) => onFolderInfoRequest?.(node as ConsoleEntry),
    [onFolderInfoRequest],
  );
  const handleMoveRequest = useCallback(
    (node: ResourceTreeNode) => onMoveRequest?.(node as ConsoleEntry),
    [onMoveRequest],
  );
  const handleResortItem = useCallback(
    (id: string) => {
      if (!currentWorkspace) return;
      resortItem(currentWorkspace.id, id);
    },
    [currentWorkspace, resortItem],
  );
  const handleCanManageItem = useCallback(
    (node: ResourceTreeNode) => canManage(node as ConsoleEntry),
    [canManage],
  );
  const getResourceItemIcon = useCallback(
    (node: ResourceTreeNode) => getItemIcon(node as ConsoleEntry),
    [getItemIcon],
  );
  const getResourceFolderExpansionKey = useCallback(
    (node: ResourceTreeNode) => node.id,
    [],
  );

  return (
    <ResourceTree
      ref={resourceTreeRef}
      sections={sections}
      mode={mode}
      activeItemId={mode === "sidebar" ? activeTabId : null}
      searchQuery={searchQuery}
      getItemIcon={getResourceItemIcon}
      showFiles={showFiles}
      hideFolderIcon
      enableDragDrop={enableDragDrop}
      enableRename={enableRename}
      enableDuplicate={enableDuplicate}
      enableDelete={enableDelete}
      enableMove={enableMove}
      enableInfo={enableInfo}
      enableNewFolder
      onItemClick={handleResourceItemClick}
      onPickerFileClick={handlePickerFileClick}
      onLocationChange={handleLocationChange}
      selectedLocationId={selectedLocationId}
      selectedSectionKey={selectedSectionKey}
      initialFolderId={initialFolderId}
      initialSectionKey={initialSection}
      onMoveItem={handleMoveItem}
      onMoveFolder={handleMoveFolder}
      onRenameItem={handleRenameItem}
      onDeleteItem={handleDeleteItem}
      onDuplicateItem={handleDuplicateItem}
      onCreateFolder={handleCreateFolder}
      onInfoRequest={handleInfoRequest}
      onFolderInfoRequest={handleFolderInfoRequest}
      onMoveRequest={handleMoveRequest}
      onResortItem={handleResortItem}
      onUndo={onUndo}
      isFolderExpanded={isFolderExpandedLocal}
      onToggleFolder={toggleFolder}
      onExpandFolder={expandFolder}
      getFolderExpansionKey={getResourceFolderExpansionKey}
      canManageItem={handleCanManageItem}
    />
  );
}

const ConsoleTree = forwardRef<ConsoleTreeRef, ConsoleTreeProps>(
  ConsoleTreeInner,
);

ConsoleTree.displayName = "ConsoleTree";

export default ConsoleTree;
