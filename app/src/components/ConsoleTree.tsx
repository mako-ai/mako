import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { TAB_KIND_ICONS } from "../lib/entity-icons";

const ConsoleIcon = TAB_KIND_ICONS.console;
import { Box } from "@mui/material";
import { useExplorerStore } from "../store/explorerStore";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
} from "../store/consoleTreeStore";
import { useResourceTreeExplorer } from "../hooks/useResourceTreeExplorer";
import ResourceTree, {
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

  // The console tree is preloaded by workspace-context; a sidebar or picker
  // mounting must not refetch it.
  const tree = useResourceTreeExplorer(
    useConsoleTreeStore,
    currentWorkspace?.id,
    { autoFetch: false },
  );
  const { myItems: myConsoles, workspaceItems: sharedWithWorkspace } = tree;
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);

  const activeTabId = useConsoleStore(state => state.activeTabId);

  // Only the sidebar tree honors reveal requests; pickers ignore them.
  const revealRequest = useExplorerRevealStore(selectRevealFor("consoles"));
  const reveal = mode === "sidebar" ? revealRequest : null;

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

      if (iconUrl) {
        return (
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
        );
      }
      // Fallback when a console has no connection yet, or the catalog
      // hasn't loaded / doesn't know this type.
      return <ConsoleIcon size={16} strokeWidth={1.5} />;
    },
    [typeIconUrlByConnectionId],
  );

  const handleLocationChange = useCallback(
    (folderId: string | null, sectionKey: string) => {
      if (sectionKey === "my" || sectionKey === "workspace") {
        onLocationChange?.(folderId, sectionKey);
      }
    },
    [onLocationChange],
  );

  // Delete is the one handler the hook's confirm-dialog flow does not cover:
  // the sidebar hands it to the explorer (confirm for folders, soft delete
  // with undo for consoles); the picker deletes outright.
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

      await deleteItem(
        currentWorkspace.id,
        consoleNode.id,
        consoleNode.isDirectory,
      );
    },
    [currentWorkspace, deleteItem, mode, onDeleteRequest, onSoftDelete],
  );

  // Not `tree.sections`: console sections carry no header icon and are only
  // drop targets when drag-and-drop is on (the picker turns it off).
  const sections = [
    {
      key: "my",
      label: "My Consoles",
      nodes: myConsoles,
      droppableId: enableDragDrop ? "__section_my" : undefined,
      defaultAccess: "private" as const,
    },
    {
      key: "workspace",
      label: "Workspace",
      nodes: sharedWithWorkspace,
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
      revealNodeId={reveal?.nodeId}
      revealNonce={reveal?.nonce}
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
      {...tree.treeHandlers}
      onDeleteItem={handleDeleteItem}
      onDuplicateItem={handleDuplicateItem}
      onInfoRequest={handleInfoRequest}
      onFolderInfoRequest={handleFolderInfoRequest}
      onMoveRequest={handleMoveRequest}
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
