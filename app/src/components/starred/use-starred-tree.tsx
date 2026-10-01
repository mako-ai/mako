/**
 * The Starred tree's wiring for an explorer whose rows are entities with
 * their own folder tree (Notebooks, Dashboards). One implementation for both:
 * the two copies had already drifted (one starred folders on the header, one
 * routed the header's "New Folder" to the real tree).
 *
 * Rows under Starred are VIEWS: their moves, renames and deletes go to the
 * favourites store, never to the entity store, which would act on an id it
 * does not know. Dropping a real row into a Starred folder stars it there —
 * or MOVES the existing star (adding again is idempotent server-side and the
 * row would snap back). Only an entity the caller says is starrable becomes
 * a favourite: a real FOLDER dropped on Starred would become an item row
 * pointing at a folder id, invisible and impossible to remove.
 */
import { useCallback, useMemo } from "react";
import { ListItemIcon, MenuItem } from "@mui/material";
import { FolderPlus as FolderPlusIcon } from "lucide-react";
import type { ResourceTreeNode } from "../ResourceTree";
import {
  favouriteFor,
  useFavouritesStore,
  type Favourite,
} from "../../store/favouritesStore";
import {
  STARRED_SECTION_KEY,
  entityIdFromStarredRow,
  favouriteIdFromFolderRow,
  isStarredRow,
} from "./starred-section";

/** The handlers `useResourceTreeExplorer` hands back for the real tree. */
export interface BaseTreeHandlers {
  onMoveItem: (id: string, folderId: string | null, access?: string) => void;
  onMoveFolder: (id: string, parentId: string | null, access?: string) => void;
  onRenameItem: (id: string, name: string, isDirectory: boolean) => void;
  onDeleteItem: (node: ResourceTreeNode) => void;
  onCreateFolder: (
    parentId: string | null,
    access?: string,
  ) => Promise<{ id: string; name: string } | null>;
  onResortItem?: (id: string) => void;
}

export function useStarredTree(options: {
  kind: NonNullable<Favourite["kind"]>;
  workspaceId: string | undefined;
  favourites: Favourite[];
  base: BaseTreeHandlers;
  /** Can this REAL row be starred? Entities yes; their folders never. */
  isStarrable: (id: string) => boolean;
  /** Unstar (a pinned row's delete). */
  onToggleStar: (entityId: string) => void;
}): {
  treeHandlers: BaseTreeHandlers;
  handleSectionDrop: (sectionKey: string, nodeId: string) => boolean;
  getSectionContextMenuItems: (
    sectionKey: string,
    helpers: { closeMenu: () => void },
  ) => React.ReactNode[] | null;
} {
  const { kind, workspaceId, favourites, base, isStarrable, onToggleStar } =
    options;
  const toggleFavourite = useFavouritesStore(s => s.toggle);
  const moveFavourite = useFavouritesStore(s => s.move);
  const createFavouriteFolder = useFavouritesStore(s => s.createFolder);
  const renameFavourite = useFavouritesStore(s => s.rename);
  const removeFavourite = useFavouritesStore(s => s.remove);

  const treeHandlers = useMemo<BaseTreeHandlers>(() => {
    const { onMoveItem, onMoveFolder, onRenameItem, onDeleteItem, ...rest } =
      base;
    const favIdOf = (entityId: string) =>
      favourites.find(f => f.kind === kind && f.refId === entityId)?.id;
    const moveStarred = (id: string, targetId: string | null) => {
      if (!workspaceId) return;
      const targetFav = targetId ? favouriteIdFromFolderRow(targetId) : null;
      const pinnedTarget = targetId ? entityIdFromStarredRow(targetId) : null;
      // A drop on anything that is not a Starred folder or pinned row (a
      // real folder) is not a move within Starred: leave the star alone.
      if (targetId && targetFav === null && pinnedTarget === null) return;
      const dest =
        targetFav ??
        (pinnedTarget
          ? (favourites.find(f => f.refId === pinnedTarget)?.parentId ?? null)
          : null);
      const pinned = entityIdFromStarredRow(id);
      const favId = pinned ? favIdOf(pinned) : favouriteIdFromFolderRow(id);
      if (favId) void moveFavourite(workspaceId, favId, dest);
    };
    const starInto = (id: string, folderId: string) => {
      if (!workspaceId || !isStarrable(id)) return;
      const fav = favouriteIdFromFolderRow(folderId);
      const existing = favouriteFor(favourites, kind, id);
      if (existing) void moveFavourite(workspaceId, existing.id, fav);
      else void toggleFavourite(workspaceId, kind, id, true, fav);
    };
    return {
      ...rest,
      onMoveItem: (id, folderId, access) => {
        if (isStarredRow(id)) moveStarred(id, folderId);
        else if (folderId && isStarredRow(folderId)) starInto(id, folderId);
        else onMoveItem(id, folderId, access);
      },
      onMoveFolder: (id, parentId, access) => {
        if (isStarredRow(id)) moveStarred(id, parentId);
        else if (parentId && isStarredRow(parentId)) starInto(id, parentId);
        else onMoveFolder(id, parentId, access);
      },
      onRenameItem: (id, name, isDirectory) => {
        const fav = favouriteIdFromFolderRow(id);
        if (fav) {
          if (workspaceId) void renameFavourite(workspaceId, fav, name);
        } else if (!isStarredRow(id)) onRenameItem(id, name, isDirectory);
      },
      onDeleteItem: node => {
        const pinned = entityIdFromStarredRow(node.id);
        const fav = favouriteIdFromFolderRow(node.id);
        if (pinned) onToggleStar(pinned);
        else if (fav) {
          if (workspaceId) void removeFavourite(workspaceId, fav);
        } else onDeleteItem(node);
      },
      onCreateFolder: async (parentId, access) => {
        const fav = parentId ? favouriteIdFromFolderRow(parentId) : null;
        if (!parentId || fav === null) {
          return base.onCreateFolder(parentId, access);
        }
        if (!workspaceId) return null;
        const row = await createFavouriteFolder(workspaceId, "New folder", fav);
        return row
          ? { id: `__starfolder__${row.id}`, name: row.title ?? "" }
          : null;
      },
    };
  }, [
    base,
    kind,
    workspaceId,
    favourites,
    isStarrable,
    onToggleStar,
    moveFavourite,
    toggleFavourite,
    renameFavourite,
    removeFavourite,
    createFavouriteFolder,
  ]);

  /**
   * A drop on a section HEADER. On Starred: file at the Starred root (a
   * pin or a Starred folder), or star a real entity there. On any other
   * header, a starred row is consumed as a no-op — otherwise ResourceTree
   * falls through to onMoveItem(id, null) and re-parents the star to the
   * Starred root.
   */
  const handleSectionDrop = useCallback(
    (sectionKey: string, nodeId: string): boolean => {
      if (sectionKey !== STARRED_SECTION_KEY) return isStarredRow(nodeId);
      if (!workspaceId) return true;
      const pinned = entityIdFromStarredRow(nodeId);
      const fav = favouriteIdFromFolderRow(nodeId);
      if (fav) void moveFavourite(workspaceId, fav, null);
      else if (pinned) {
        const row = favourites.find(f => f.kind === kind && f.refId === pinned);
        if (row) void moveFavourite(workspaceId, row.id, null);
      } else if (!isStarredRow(nodeId) && isStarrable(nodeId)) {
        void toggleFavourite(workspaceId, kind, nodeId, true, null);
      }
      return true;
    },
    [
      workspaceId,
      kind,
      favourites,
      isStarrable,
      moveFavourite,
      toggleFavourite,
    ],
  );

  /**
   * The Starred header's own menu: "New folder" creates a FAVOURITES folder.
   * Without this override ResourceTree's default item creates a real
   * notebook/dashboard folder under My … instead.
   */
  const getSectionContextMenuItems = useCallback(
    (sectionKey: string, helpers: { closeMenu: () => void }) => {
      if (sectionKey !== STARRED_SECTION_KEY) return null;
      return [
        <MenuItem
          key="new-star-folder"
          onClick={() => {
            helpers.closeMenu();
            if (workspaceId) {
              void createFavouriteFolder(workspaceId, "New folder", null);
            }
          }}
        >
          <ListItemIcon>
            <FolderPlusIcon size={16} />
          </ListItemIcon>
          New folder
        </MenuItem>,
      ];
    },
    [workspaceId, createFavouriteFolder],
  );

  return { treeHandlers, handleSectionDrop, getSectionContextMenuItems };
}
