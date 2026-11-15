import {
  Globe as GlobeIcon,
  User as UserIcon,
  Users as SharedIcon,
  Clock as RecentIcon,
  TrendingUp as PopularIcon,
} from "lucide-react";
import { appRootOf, type AppMeta } from "../../store/appsStore";
import { buildAppTree } from "../../lib/apps-explorer-tree";
import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import { buildStarredSection } from "../starred/starred-section";
import { buildShortcutSection } from "../starred/shortcut-section";
import { popularApps } from "../../lib/apps-discovery";
import {
  PERSONAL_SECTION,
  POPULAR_SECTION,
  RECENT_SECTION,
  SHARED_SECTION,
  SHORTCUT_LIMIT,
  WORKSPACE_ROOT,
  WORKSPACE_SECTION,
} from "./node-model";

interface BuildAppsSectionsArgs {
  apps: AppMeta[];
  folders: string[];
  favourites: Parameters<typeof buildStarredSection>[0];
  appById: Map<string, AppMeta>;
  appChildren: (appId: string) => ResourceTreeNode[] | undefined;
  personalRoot: string | null;
  userId: string | undefined;
  discovery: {
    recent: Array<{ appId: string }>;
    usage: Parameters<typeof popularApps>[1];
  };
}

/**
 * The Apps explorer's sections: Starred, Recently viewed, Popular, Personal,
 * Workspace and (when any) Shared with me.
 */
export function buildAppsSections({
  apps,
  folders,
  favourites,
  appById,
  appChildren,
  personalRoot,
  userId,
  discovery,
}: BuildAppsSectionsArgs): ResourceTreeSection[] {
  const treeApps = (list: AppMeta[]) =>
    list.map(a => ({
      id: a.id,
      title: a.title,
      path: appRootOf(a),
      access: a.access,
      owner_id: a.owner_id,
    }));
  const workspaceApps = apps.filter(
    a => (a.scope ?? "workspace") === "workspace",
  );
  const personalApps = personalRoot
    ? apps.filter(a => appRootOf(a).startsWith(`${personalRoot}/`))
    : [];
  // Someone else's personal app that they shared with you: the list
  // returns it (you can read it), but it lives in THEIR tree, which is
  // never rendered here. Flat rows, no folder chrome, not a drop target —
  // only the owner can move it, so a drag here has nothing to do.
  const sharedWithMe = apps.filter(
    a =>
      a.scope === "private" &&
      !!a.owner_id &&
      a.owner_id !== userId &&
      !(personalRoot && appRootOf(a).startsWith(`${personalRoot}/`)),
  );
  const starredSection = buildStarredSection(
    favourites,
    "app",
    appId => {
      const app = appById.get(appId);
      return app
        ? {
            name: app.title,
            path: appRootOf(app),
            entityType: "app",
            access: app.access,
            owner_id: app.owner_id,
          }
        : undefined;
    },
    { droppable: true },
  );
  // Shortcuts, resolved against the same listing (so a private app the
  // usage API mentions but this person cannot see never shows).
  const shortcutRow = (appId: string) => {
    const app = appById.get(appId);
    return app
      ? {
          name: app.title,
          path: appRootOf(app),
          entityType: "app",
          access: app.access,
          owner_id: app.owner_id,
        }
      : undefined;
  };
  const recentSection = buildShortcutSection({
    key: RECENT_SECTION,
    label: "Recently viewed",
    icon: <RecentIcon size={16} strokeWidth={1.5} />,
    refIds: discovery.recent.map(r => r.appId),
    resolve: shortcutRow,
    limit: SHORTCUT_LIMIT,
  });
  const popularSection = buildShortcutSection({
    key: POPULAR_SECTION,
    label: "Popular",
    icon: <PopularIcon size={16} strokeWidth={1.5} />,
    refIds: popularApps(apps, discovery.usage, SHORTCUT_LIMIT).map(a => a.id),
    resolve: shortcutRow,
    limit: SHORTCUT_LIMIT,
  });
  return [
    ...starredSection,
    ...recentSection,
    ...popularSection,
    ...(personalRoot
      ? [
          {
            key: PERSONAL_SECTION,
            label: "Personal",
            icon: <UserIcon size={16} strokeWidth={1.5} />,
            nodes: buildAppTree({
              root: personalRoot,
              folders,
              apps: treeApps(personalApps),
              appChildren,
            }),
            droppableId: "__section_personal",
          },
        ]
      : []),
    {
      key: WORKSPACE_SECTION,
      label: "Workspace",
      icon: <GlobeIcon size={16} strokeWidth={1.5} />,
      nodes: buildAppTree({
        root: WORKSPACE_ROOT,
        folders,
        apps: treeApps(workspaceApps),
        appChildren,
      }),
      droppableId: "__section_workspace",
    },
    ...(sharedWithMe.length > 0
      ? [
          {
            key: SHARED_SECTION,
            label: "Shared with me",
            icon: <SharedIcon size={16} strokeWidth={1.5} />,
            nodes: sharedWithMe
              .map(app => ({
                id: app.id,
                name: app.title,
                path: appRootOf(app),
                isDirectory: true,
                children: appChildren(app.id),
                ...(app.access ? { access: app.access } : {}),
                ...(app.owner_id ? { owner_id: app.owner_id } : {}),
              }))
              .sort((a, b) =>
                a.name.localeCompare(b.name, undefined, {
                  sensitivity: "base",
                }),
              ),
          },
        ]
      : []),
  ];
}
