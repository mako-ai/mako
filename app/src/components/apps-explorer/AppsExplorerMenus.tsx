import { useCallback } from "react";
import { ListItemIcon, MenuItem } from "@mui/material";
import {
  FolderPlus as FolderPlusIcon,
  KeyRound as EnvIcon,
  Pencil as RenameIcon,
  Plus as AddIcon,
  Star as StarIcon,
  Trash2 as DeleteIcon,
  UserPlus as ShareMenuIcon,
  Wand2 as StampIcon,
  BadgeCheck as VerifiedIcon,
  Share2 as ShareWorkspaceIcon,
} from "lucide-react";
import { useAppsStore, type AppMeta } from "../../store/appsStore";
import { basenameOf } from "../../lib/apps-explorer-tree";
import { type ResourceTreeNode } from "../ResourceTree";
import { STARRED_SECTION_KEY } from "../starred/starred-section";
import {
  PERSONAL_SECTION,
  WORKSPACE_ROOT,
  WORKSPACE_SECTION,
  parseNodeId,
  type FolderDialogState,
} from "./node-model";

interface UseAppsExplorerMenusArgs {
  workspaceId: string | undefined;
  user: { id?: string } | null | undefined;
  isWorkspaceAdmin: boolean;
  personalRoot: string | null;
  appById: Map<string, AppMeta>;
  starred: Set<string>;
  favourites: Array<{ id: string; title?: string | null }>;
  handleToggleStar: (appId: string) => void;
  handleDelete: (appId: string) => Promise<void>;
  handleDeleteFolder: (folderPath: string) => Promise<void>;
  handleCreateStarFolder: (parentId: string | null) => Promise<unknown>;
  handleDeleteStarFolder: (favId: string) => Promise<void>;
  setShareAppId: (appId: string) => void;
  setEnvAppId: (appId: string) => void;
  setShareWsAppId: (appId: string) => void;
  setCreateFolder: (folderPath: string) => void;
  setCreateOpen: (open: boolean) => void;
  setFolderDialog: (state: FolderDialogState | null) => void;
}

/** Context menus for app rows, git folders, Starred folders and sections. */
export function useAppsExplorerMenus({
  workspaceId,
  user,
  isWorkspaceAdmin,
  personalRoot,
  appById,
  starred,
  favourites,
  handleToggleStar,
  handleDelete,
  handleDeleteFolder,
  handleCreateStarFolder,
  handleDeleteStarFolder,
  setShareAppId,
  setEnvAppId,
  setShareWsAppId,
  setCreateFolder,
  setCreateOpen,
  setFolderDialog,
}: UseAppsExplorerMenusArgs) {
  const stampAppId = useAppsStore(s => s.stampAppId);
  const setAppVerified = useAppsStore(s => s.setAppVerified);

  const appMenuItems = useCallback(
    (appId: string, pinned: boolean, helpers: { closeMenu: () => void }) => {
      const app = appById.get(appId);
      const isStarred = starred.has(appId);
      const items = [
        <MenuItem
          key="star"
          onClick={() => {
            helpers.closeMenu();
            handleToggleStar(appId);
          }}
        >
          <ListItemIcon>
            <StarIcon size={16} fill={isStarred ? "currentColor" : "none"} />
          </ListItemIcon>
          {isStarred ? "Unstar" : "Star"}
        </MenuItem>,
        <MenuItem
          key="share"
          onClick={() => {
            helpers.closeMenu();
            setShareAppId(appId);
          }}
        >
          <ListItemIcon>
            <ShareMenuIcon size={16} />
          </ListItemIcon>
          Share…
        </MenuItem>,
      ];
      if (pinned) return items;
      items.push(
        <MenuItem
          key="env"
          onClick={() => {
            helpers.closeMenu();
            setEnvAppId(appId);
          }}
        >
          <ListItemIcon>
            <EnvIcon size={16} />
          </ListItemIcon>
          Environment variables…
        </MenuItem>,
      );
      // Lifecycle + curation (app-lifecycle.service.ts on the API).
      if (app?.scope === "private" && app.owner_id === user?.id) {
        items.push(
          <MenuItem
            key="share-workspace"
            onClick={() => {
              helpers.closeMenu();
              setShareWsAppId(appId);
            }}
          >
            <ListItemIcon>
              <ShareWorkspaceIcon size={16} />
            </ListItemIcon>
            Share with workspace…
          </MenuItem>,
        );
      }
      if (isWorkspaceAdmin && app?.scope === "workspace") {
        items.push(
          <MenuItem
            key="verified"
            onClick={() => {
              helpers.closeMenu();
              if (workspaceId) {
                void setAppVerified(workspaceId, appId, !app.verified);
              }
            }}
          >
            <ListItemIcon>
              <VerifiedIcon size={16} />
            </ListItemIcon>
            {app.verified ? "Remove verified mark" : "Mark as verified"}
          </MenuItem>,
        );
      }
      if (app?.duplicateOf) {
        items.push(
          <MenuItem
            key="stamp"
            onClick={() => {
              helpers.closeMenu();
              if (workspaceId) void stampAppId(workspaceId, appId);
            }}
          >
            <ListItemIcon>
              <StampIcon size={16} />
            </ListItemIcon>
            Give this copy its own id
          </MenuItem>,
        );
      }
      items.push(
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDelete(appId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Delete app
        </MenuItem>,
      );
      return items;
    },
    [
      appById,
      starred,
      handleToggleStar,
      workspaceId,
      stampAppId,
      handleDelete,
      user?.id,
      isWorkspaceAdmin,
      setAppVerified,
    ],
  );

  const folderMenuItems = useCallback(
    (folderPath: string, helpers: { closeMenu: () => void }) => [
      <MenuItem
        key="new-app"
        onClick={() => {
          helpers.closeMenu();
          setCreateFolder(folderPath);
          setCreateOpen(true);
        }}
      >
        <ListItemIcon>
          <AddIcon size={16} />
        </ListItemIcon>
        New app here…
      </MenuItem>,
      <MenuItem
        key="new-folder"
        onClick={() => {
          helpers.closeMenu();
          setFolderDialog({ mode: "create", path: folderPath });
        }}
      >
        <ListItemIcon>
          <FolderPlusIcon size={16} />
        </ListItemIcon>
        New folder…
      </MenuItem>,
      ...(folderPath !== WORKSPACE_ROOT && folderPath !== personalRoot
        ? [
            <MenuItem
              key="rename"
              onClick={() => {
                helpers.closeMenu();
                setFolderDialog({
                  mode: "rename",
                  path: folderPath,
                  initialName: basenameOf(folderPath),
                });
              }}
            >
              <ListItemIcon>
                <RenameIcon size={16} />
              </ListItemIcon>
              Rename…
            </MenuItem>,
            <MenuItem
              key="delete"
              onClick={() => {
                helpers.closeMenu();
                void handleDeleteFolder(folderPath);
              }}
            >
              <ListItemIcon>
                <DeleteIcon size={16} />
              </ListItemIcon>
              Delete folder
            </MenuItem>,
          ]
        : []),
    ],
    [personalRoot, handleDeleteFolder],
  );

  const starFolderMenuItems = useCallback(
    (favId: string, helpers: { closeMenu: () => void }) => {
      const row = favourites.find(f => f.id === favId);
      return [
        <MenuItem
          key="new-folder"
          onClick={() => {
            helpers.closeMenu();
            setFolderDialog({
              mode: "create",
              path: "",
              favId: undefined,
              initialName: "",
            });
            // A Starred subfolder is created on the spot; the dialog is not
            // needed. Mirror what the section header does.
            setFolderDialog(null);
            void handleCreateStarFolder(favId);
          }}
        >
          <ListItemIcon>
            <FolderPlusIcon size={16} />
          </ListItemIcon>
          New folder
        </MenuItem>,
        <MenuItem
          key="rename"
          onClick={() => {
            helpers.closeMenu();
            setFolderDialog({
              mode: "rename",
              path: "",
              favId,
              initialName: row?.title ?? "",
            });
          }}
        >
          <ListItemIcon>
            <RenameIcon size={16} />
          </ListItemIcon>
          Rename…
        </MenuItem>,
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDeleteStarFolder(favId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Remove folder
        </MenuItem>,
      ];
    },
    [favourites, handleCreateStarFolder, handleDeleteStarFolder],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        return appMenuItems(parsed.appId, parsed.pinned, helpers);
      }
      if (parsed.kind === "folder") {
        return folderMenuItems(parsed.folderPath, helpers);
      }
      if (parsed.kind === "starfolder") {
        return starFolderMenuItems(parsed.favId, helpers);
      }
      return null;
    },
    [appMenuItems, folderMenuItems, starFolderMenuItems],
  );

  const getSectionContextMenuItems = useCallback(
    (sectionKey: string, helpers: { closeMenu: () => void }) => {
      if (sectionKey === STARRED_SECTION_KEY) {
        return [
          <MenuItem
            key="new-folder"
            onClick={() => {
              helpers.closeMenu();
              void handleCreateStarFolder(null);
            }}
          >
            <ListItemIcon>
              <FolderPlusIcon size={16} />
            </ListItemIcon>
            New folder
          </MenuItem>,
        ];
      }
      if (sectionKey !== WORKSPACE_SECTION && sectionKey !== PERSONAL_SECTION) {
        return null;
      }
      const root =
        sectionKey === PERSONAL_SECTION ? personalRoot : WORKSPACE_ROOT;
      if (!root) return null;
      return folderMenuItems(root, helpers);
    },
    [handleCreateStarFolder, personalRoot, folderMenuItems],
  );

  return { getContextMenuItems, getSectionContextMenuItems };
}
