import { useCallback } from "react";
import { appRootOf, useAppsStore, type AppMeta } from "../../store/appsStore";
import { favouriteFor, useFavouritesStore } from "../../store/favouritesStore";
import { basenameOf, parentPathOf } from "../../lib/apps-explorer-tree";
import { STARRED_SECTION_KEY } from "../starred/starred-section";
import { PERSONAL_SECTION, WORKSPACE_ROOT, parseNodeId } from "./node-model";

interface UseAppsTreeActionsArgs {
  workspaceId: string | undefined;
  userId: string | undefined;
  personalRoot: string | null;
  canOrganize: boolean;
  appById: Map<string, AppMeta>;
  starred: Set<string>;
  favourites: Parameters<typeof favouriteFor>[0];
}

/**
 * Who may move what, starring, and what a drop onto a row or a section
 * header does (move an app / folder, file a star).
 */
export function useAppsTreeActions({
  workspaceId,
  userId,
  personalRoot,
  canOrganize,
  appById,
  starred,
  favourites,
}: UseAppsTreeActionsArgs) {
  const toggleFavourite = useFavouritesStore(s => s.toggle);
  const moveFavourite = useFavouritesStore(s => s.move);
  const moveApp = useAppsStore(s => s.moveApp);
  const moveAppFolder = useAppsStore(s => s.moveAppFolder);

  /** An app in someone else's personal tree: readable, never movable here. */
  const isSharedWithMe = useCallback(
    (appId: string): boolean => {
      const app = appById.get(appId);
      return (
        !!app &&
        app.scope === "private" &&
        !!app.owner_id &&
        app.owner_id !== userId
      );
    },
    [appById, userId],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const setError = useCallback((message: string) => {
    useAppsStore.setState(s => {
      s.error = message;
    });
  }, []);

  /** Where a target folder path may be written to by this person. */
  const mayWriteTo = useCallback(
    (folderPath: string): boolean => {
      if (
        personalRoot &&
        (folderPath === personalRoot ||
          folderPath.startsWith(`${personalRoot}/`))
      ) {
        return true;
      }
      if (!canOrganize) {
        setError("Only workspace editors can reorganise the Workspace tree.");
        return false;
      }
      return true;
    },
    [canOrganize, personalRoot, setError],
  );

  const handleToggleStar = useCallback(
    (appId: string, parentId: string | null = null) => {
      if (!workspaceId) return;
      void toggleFavourite(
        workspaceId,
        "app",
        appId,
        !starred.has(appId),
        parentId,
      );
    },
    [workspaceId, toggleFavourite, starred],
  );

  /** The folder an app or file row sits in (its parent directory). */
  const folderOfApp = useCallback(
    (appId: string): string | null => {
      const app = appById.get(appId);
      return app ? parentPathOf(appRootOf(app)) : null;
    },
    [appById],
  );

  /** A drop onto a section header: the root of that tree. */
  const handleSectionDrop = useCallback(
    (sectionKey: string, nodeId: string): boolean => {
      if (!workspaceId) return true;
      const dragged = parseNodeId(nodeId);
      if (sectionKey === STARRED_SECTION_KEY) {
        if (dragged.kind === "app") {
          const row = favouriteFor(favourites, "app", dragged.appId);
          if (row) void moveFavourite(workspaceId, row.id, null);
          else {
            void toggleFavourite(workspaceId, "app", dragged.appId, true, null);
          }
        } else if (dragged.kind === "starfolder") {
          void moveFavourite(workspaceId, dragged.favId, null);
        }
        return true;
      }
      const root =
        sectionKey === PERSONAL_SECTION ? personalRoot : WORKSPACE_ROOT;
      if (!root || !mayWriteTo(root)) return true;
      if (dragged.kind === "app" && !dragged.pinned) {
        if (
          folderOfApp(dragged.appId) !== root &&
          !isSharedWithMe(dragged.appId)
        ) {
          void moveApp(workspaceId, dragged.appId, root);
        }
      } else if (dragged.kind === "folder") {
        const to = `${root}/${basenameOf(dragged.folderPath)}`;
        if (to !== dragged.folderPath && mayWriteTo(dragged.folderPath)) {
          void moveAppFolder(workspaceId, dragged.folderPath, to);
        }
      }
      return true;
    },
    [
      workspaceId,
      favourites,
      moveFavourite,
      toggleFavourite,
      personalRoot,
      mayWriteTo,
      folderOfApp,
      moveApp,
      moveAppFolder,
      isSharedWithMe,
    ],
  );

  /** A drop onto a row: file the dragged thing next to / inside it. */
  const handleMoveNode = useCallback(
    (nodeId: string, targetId: string | null) => {
      if (!workspaceId || !targetId) return;
      const dragged = parseNodeId(nodeId);
      const target = parseNodeId(targetId);
      // Shortcut rows are views of a row below: nothing to drop onto.
      if (target.kind === "app" && target.shortcut) return;
      if (dragged.kind === "app" && dragged.shortcut) return;
      // A shared app can be starred (a pinned row is a view of it), never
      // filed: it is the owner's to move, and the server would refuse.
      if (
        dragged.kind === "app" &&
        !dragged.pinned &&
        isSharedWithMe(dragged.appId) &&
        target.kind !== "starfolder" &&
        !(target.kind === "app" && target.pinned)
      ) {
        return;
      }

      // Destination: a git folder path, or a favourites folder id (null =
      // the Starred root when the target is a pinned row at the root).
      let destPath: string | null = null;
      let destFav: string | null | undefined;
      if (target.kind === "folder") destPath = target.folderPath;
      else if (target.kind === "starfolder") destFav = target.favId;
      else if (target.kind === "app" && target.pinned) {
        destFav =
          favouriteFor(favourites, "app", target.appId)?.parentId ?? null;
      } else if (target.kind === "app") destPath = folderOfApp(target.appId);
      else destPath = folderOfApp(target.appId);

      if (dragged.kind === "app") {
        if (destFav !== undefined) {
          const row = favouriteFor(favourites, "app", dragged.appId);
          if (row) void moveFavourite(workspaceId, row.id, destFav);
          else {
            void toggleFavourite(
              workspaceId,
              "app",
              dragged.appId,
              true,
              destFav,
            );
          }
          return;
        }
        // A pinned copy dragged into a real folder is a misdrop, not a move.
        if (dragged.pinned || !destPath) return;
        if (folderOfApp(dragged.appId) === destPath) return;
        if (!mayWriteTo(destPath)) return;
        const from = folderOfApp(dragged.appId);
        if (from && !mayWriteTo(from)) return;
        void moveApp(workspaceId, dragged.appId, destPath);
        return;
      }
      if (dragged.kind === "folder") {
        if (!destPath || destPath === dragged.folderPath) return;
        if (destPath.startsWith(`${dragged.folderPath}/`)) return;
        const to = `${destPath}/${basenameOf(dragged.folderPath)}`;
        if (!mayWriteTo(destPath) || !mayWriteTo(dragged.folderPath)) return;
        void moveAppFolder(workspaceId, dragged.folderPath, to);
        return;
      }
      if (dragged.kind === "starfolder" && destFav !== undefined) {
        if (destFav !== dragged.favId) {
          void moveFavourite(workspaceId, dragged.favId, destFav);
        }
      }
    },
    [
      workspaceId,
      favourites,
      folderOfApp,
      isSharedWithMe,
      mayWriteTo,
      moveApp,
      moveAppFolder,
      moveFavourite,
      toggleFavourite,
    ],
  );

  return {
    isSharedWithMe,
    mayWriteTo,
    handleToggleStar,
    folderOfApp,
    handleSectionDrop,
    handleMoveNode,
  };
}
