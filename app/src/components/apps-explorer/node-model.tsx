import {
  Braces as JsonFileIcon,
  Database as BindingIcon,
  File as PlainFileIcon,
  FileCode as CodeFileIcon,
  FileText as TextFileIcon,
} from "lucide-react";
import { type AppFileEntry } from "../../store/appsStore";
import { APP_DIR_SEP, APP_FILE_SEP } from "../../lib/explorer-reveal";
import { TAB_KIND_ICONS } from "../../lib/entity-icons";
import { folderPathFromNodeId } from "../../lib/apps-explorer-tree";
import { type ResourceTreeNode } from "../ResourceTree";
import {
  entityIdFromStarredRow,
  favouriteIdFromFolderRow,
} from "../starred/starred-section";
import { parseShortcutRow } from "../starred/shortcut-section";

export const AppIcon = TAB_KIND_ICONS["app"];
export const AppsHomeIcon = TAB_KIND_ICONS["apps-home"];

export const WORKSPACE_ROOT = "apps";
export const WORKSPACE_SECTION = "workspace";
export const PERSONAL_SECTION = "personal";
export const SHARED_SECTION = "shared-with-me";

export const RECENT_SECTION = "recently-viewed";
export const POPULAR_SECTION = "popular";
/** Rows per shortcut section: a glance, not a second tree. */
export const SHORTCUT_LIMIT = 5;

export type ParsedNode =
  /** `pinned`: a Starred copy; `shortcut`: a Recently viewed / Popular one. */
  | { kind: "app"; appId: string; pinned: boolean; shortcut?: boolean }
  | { kind: "dir" | "file"; appId: string; path: string }
  | { kind: "folder"; folderPath: string }
  | { kind: "starfolder"; favId: string };

export function parseNodeId(id: string): ParsedNode {
  const shortcut = parseShortcutRow(id);
  if (shortcut) {
    return { kind: "app", appId: shortcut.refId, pinned: true, shortcut: true };
  }
  const folderPath = folderPathFromNodeId(id);
  if (folderPath !== null) return { kind: "folder", folderPath };
  const favId = favouriteIdFromFolderRow(id);
  if (favId !== null) return { kind: "starfolder", favId };
  const pinned = entityIdFromStarredRow(id);
  if (pinned !== null) return { kind: "app", appId: pinned, pinned: true };
  if (id.includes(APP_FILE_SEP)) {
    const [appId, path] = id.split(APP_FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(APP_DIR_SEP)) {
    const [appId, path] = id.split(APP_DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, pinned: false };
}

// Per-extension file icons — the same mapping the legacy explorer used, so the
// two trees read identically. A binding (bindings/*.sql) gets the database
// icon: it IS a data binding, the .sql is just its serialization.
const CODE_FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "scss",
  "html",
  "sql",
]);
export function fileIcon(name: string, path: string) {
  if (/^bindings\//.test(path) && name.endsWith(".sql")) {
    return <BindingIcon size={16} strokeWidth={1.5} />;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (CODE_FILE_EXTENSIONS.has(ext)) {
    return <CodeFileIcon size={16} strokeWidth={1.5} />;
  }
  if (ext === "md" || ext === "mdx" || ext === "txt") {
    return <TextFileIcon size={16} strokeWidth={1.5} />;
  }
  if (ext === "json") {
    return <JsonFileIcon size={16} strokeWidth={1.5} />;
  }
  return <PlainFileIcon size={16} strokeWidth={1.5} />;
}

/** Build nested folder/file nodes for one app. */
export function buildFileNodes(
  appId: string,
  files: AppFileEntry[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${appId}${APP_DIR_SEP}`,
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      const id = isLeaf
        ? `${appId}${APP_FILE_SEP}${path}`
        : `${appId}${APP_DIR_SEP}${path}`;
      let child = cursor.children?.find(c => c.id === id);
      if (!child) {
        child = {
          id,
          name: segment,
          path,
          isDirectory: !isLeaf,
          children: isLeaf ? undefined : [],
        };
        cursor.children?.push(child);
      }
      cursor = child;
    });
  }
  const sort = (nodes: ResourceTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => n.children && sort(n.children));
  };
  sort(root.children || []);
  return root.children || [];
}

/** A folder path as a person reads it: `apps/Sales/CH` → `Workspace / Sales / CH`. */
export function folderLabel(path: string, personalRoot: string | null): string {
  if (path === WORKSPACE_ROOT) return "Workspace";
  if (personalRoot && path === personalRoot) return "Personal";
  if (path.startsWith(`${WORKSPACE_ROOT}/`)) {
    return `Workspace / ${path.slice(WORKSPACE_ROOT.length + 1).replace(/\//g, " / ")}`;
  }
  if (personalRoot && path.startsWith(`${personalRoot}/`)) {
    return `Personal / ${path.slice(personalRoot.length + 1).replace(/\//g, " / ")}`;
  }
  return path;
}

export interface FolderDialogState {
  mode: "create" | "rename";
  /** create: the parent folder; rename: the folder itself. */
  path: string;
  /** rename of a favourites folder instead of a git one. */
  favId?: string;
  initialName?: string;
}

/** The folders a new app can be created in, labelled for the picker. */
export function folderOptionsFor(
  folders: string[],
  personalRoot: string | null,
): Array<{ path: string; label: string }> {
  const out: Array<{ path: string; label: string }> = [
    { path: WORKSPACE_ROOT, label: "Workspace" },
    ...folders
      .filter(f => f.startsWith(`${WORKSPACE_ROOT}/`))
      .map(f => ({ path: f, label: folderLabel(f, personalRoot) })),
  ];
  if (personalRoot) {
    out.push({ path: personalRoot, label: "Personal" });
    out.push(
      ...folders
        .filter(f => f.startsWith(`${personalRoot}/`))
        .map(f => ({ path: f, label: folderLabel(f, personalRoot) })),
    );
  }
  return out;
}
