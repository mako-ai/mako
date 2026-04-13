import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Eye as EyeIcon,
  Globe as GlobeIcon,
  SquareTerminal as ConsoleIcon,
} from "lucide-react";
import { Box, Tooltip } from "@mui/material";
import { useExplorerStore } from "../store/explorerStore";
import { useConsoleStore } from "../store/consoleStore";
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
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
          <ConsoleIcon size={16} strokeWidth={1.5} />
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
    [isOwner],
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
      icon: <ConsoleIcon size={18} strokeWidth={1.5} />,
      nodes: myConsoles as ResourceTreeNode[],
      droppableId: enableDragDrop ? "__section_my" : undefined,
      defaultAccess: "private" as const,
    },
    {
      key: "workspace",
      label: "Workspace",
      icon: <GlobeIcon size={18} strokeWidth={1.5} />,
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

  return (
    <ResourceTree
      ref={resourceTreeRef}
      sections={sections}
      mode={mode}
      activeItemId={mode === "sidebar" ? activeTabId : null}
      searchQuery={searchQuery}
      getItemIcon={node => getItemIcon(node as ConsoleEntry)}
      showFiles={showFiles}
      enableDragDrop={enableDragDrop}
      enableRename={enableRename}
      enableDuplicate={enableDuplicate}
      enableDelete={enableDelete}
      enableMove={enableMove}
      enableInfo={enableInfo}
      enableNewFolder
      onItemClick={node => onFileOpen?.(node as ConsoleEntry)}
      onPickerFileClick={node => onFileClick?.(node as ConsoleEntry)}
      onLocationChange={handleLocationChange}
      selectedLocationId={selectedLocationId}
      selectedSectionKey={selectedSectionKey}
      initialFolderId={initialFolderId}
      initialSectionKey={initialSection}
      onMoveItem={handleMoveItem}
      onMoveFolder={handleMoveFolder}
      onRenameItem={handleRenameItem}
      onDeleteItem={handleDeleteItem}
      onDuplicateItem={node => onDuplicate?.(node as ConsoleEntry)}
      onCreateFolder={handleCreateFolder}
      onInfoRequest={node => onInfoRequest?.(node as ConsoleEntry)}
      onFolderInfoRequest={node => onFolderInfoRequest?.(node as ConsoleEntry)}
      onMoveRequest={node => onMoveRequest?.(node as ConsoleEntry)}
      onResortItem={id => {
        if (!currentWorkspace) return;
        resortItem(currentWorkspace.id, id);
      }}
      onUndo={onUndo}
      isFolderExpanded={isFolderExpandedLocal}
      onToggleFolder={toggleFolder}
      onExpandFolder={expandFolder}
      getFolderExpansionKey={node => node.id}
      canManageItem={node => canManage(node as ConsoleEntry)}
    />
  );
}

const ConsoleTree = forwardRef<ConsoleTreeRef, ConsoleTreeProps>(
  ConsoleTreeInner,
);

ConsoleTree.displayName = "ConsoleTree";

export default ConsoleTree;
