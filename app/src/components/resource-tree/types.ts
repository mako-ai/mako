import type { ReactNode } from "react";

export interface ResourceTreeNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  entityType?: string;
  children?: ResourceTreeNode[];
  access?: "private" | "workspace";
  owner_id?: string;
  readOnly?: boolean;
}

export interface ResourceTreeSection {
  key: string;
  label: string;
  icon?: ReactNode;
  nodes: ResourceTreeNode[];
  droppableId?: string;
  defaultAccess?: "private" | "workspace";
  /**
   * When true, skip rendering the section header row entirely. Useful for
   * explorers that have only one implicit section (e.g. Databases, Flows,
   * Sources) and don't want a visible group label.
   */
  hideSectionHeader?: boolean;
}

export interface CreatedFolderResult {
  id: string;
  name: string;
}

export interface ResourceTreeRef {
  createFolder: (parentId: string | null, access?: string) => Promise<void>;
}

export interface ResourceTreeProps {
  sections: ResourceTreeSection[];
  mode?: "sidebar" | "picker";
  activeItemId?: string | null;
  searchQuery?: string;

  /**
   * Reveal request: the id of a node to expand-to and scroll into view. Pair
   * it with `revealNonce` — the reveal runs whenever the nonce changes (so the
   * same node can be revealed repeatedly, e.g. re-clicking a breadcrumb). The
   * tree expands every ancestor folder, then scrolls the row into view,
   * retrying briefly to accommodate lazily-loaded children (e.g. app files).
   */
  revealNodeId?: string | null;
  revealNonce?: number;

  getItemIcon?: (
    node: ResourceTreeNode,
    ctx?: { isExpanded: boolean },
  ) => ReactNode;
  /**
   * Optional trailing adornment rendered at the right edge of a row. Used for
   * status letters, badges, or secondary glyphs (e.g. Flows status, Consoles
   * read-only eye).
   */
  getRightAdornment?: (node: ResourceTreeNode) => ReactNode;
  /**
   * When a folder is expanded and its `children` array is `undefined`, this
   * fires so the caller can lazily fetch children. Not called again while
   * children are being loaded (`isLoadingChildren` returning true).
   */
  onLoadChildren?: (node: ResourceTreeNode) => void;
  /**
   * When true for an expanded folder, the tree renders a compact skeleton row
   * in place of its children.
   */
  isLoadingChildren?: (node: ResourceTreeNode) => boolean;
  /**
   * When provided and returns a non-null array, replaces the default
   * rename/duplicate/delete/info/move context menu entries for that node.
   * Items should be `<MenuItem>` elements (or `null`). Call `helpers.closeMenu`
   * from within each MenuItem's onClick to dismiss the menu after an action.
   */
  getContextMenuItems?: (
    node: ResourceTreeNode,
    helpers: { closeMenu: () => void },
  ) => ReactNode[] | null;
  /**
   * The same override for a SECTION header's menu. When it returns a non-null
   * array those items replace the default "New Folder" entry — for an explorer
   * whose sections ARE its folders, so rename/delete belong on the header.
   */
  getSectionContextMenuItems?: (
    sectionKey: string,
    helpers: { closeMenu: () => void },
  ) => ReactNode[] | null;
  /**
   * Fires when a row is dropped on a section header, BEFORE the normal
   * move/access handling. Return `true` to claim the drop and stop there —
   * for sections that are a grouping of their own rather than an access
   * bucket (Starred, a real folder tree).
   */
  onSectionDrop?: (sectionKey: string, nodeId: string) => boolean | void;
  showFiles?: boolean;
  /**
   * When true, folder rows render only a chevron + name (no folder icon), and
   * file rows drop the hidden chevron placeholder so their icon sits in the
   * chevron column. Produces a Cursor-style compact tree.
   */
  hideFolderIcon?: boolean;

  enableDragDrop?: boolean;
  enableRename?: boolean;
  enableDuplicate?: boolean;
  enableDelete?: boolean;
  enableMove?: boolean;
  enableInfo?: boolean;
  enableNewFolder?: boolean;

  onItemClick?: (node: ResourceTreeNode) => void;
  /**
   * Opt-in: when this returns true for a directory node, clicking the row
   * (name/icon area) fires `onItemClick` instead of toggling expansion. The
   * caret — and anything left of it (the indent) — still expands/collapses.
   * Used by the database explorer so clicking a table name opens its data
   * while the caret browses the schema, and by the apps explorer so clicking
   * an app name opens the app while the caret browses its files.
   */
  shouldFolderClickActivate?: (node: ResourceTreeNode) => boolean;
  onPickerFileClick?: (node: ResourceTreeNode) => void;
  onLocationChange?: (folderId: string | null, sectionKey: string) => void;
  selectedLocationId?: string | null;
  selectedSectionKey?: string;
  initialFolderId?: string | null;
  initialSectionKey?: string;

  onMoveItem?: (
    itemId: string,
    targetFolderId: string | null,
    access?: string,
  ) => void;
  onMoveFolder?: (
    folderId: string,
    parentId: string | null,
    access?: string,
  ) => void;
  onRenameItem?: (id: string, name: string, isDirectory: boolean) => void;
  /**
   * What the inline rename box starts from, when it is not the row's
   * displayed name — an app row shows its TITLE but renames its folder
   * (slug). Defaults to `node.name`; the commit compares against the seed,
   * so an unchanged value is a resort, not a rename.
   */
  getRenameSeed?: (node: ResourceTreeNode) => string;
  onDeleteItem?: (node: ResourceTreeNode) => void;
  onDuplicateItem?: (node: ResourceTreeNode) => void;
  onCreateFolder?: (
    parentId: string | null,
    access?: string,
  ) => Promise<CreatedFolderResult | null>;
  onInfoRequest?: (node: ResourceTreeNode) => void;
  onFolderInfoRequest?: (node: ResourceTreeNode) => void;
  onMoveRequest?: (node: ResourceTreeNode) => void;
  onResortItem?: (id: string) => void;
  onUndo?: () => void;

  isFolderExpanded: (expansionKey: string) => boolean;
  onToggleFolder: (expansionKey: string) => void;
  onExpandFolder: (expansionKey: string) => void;
  getFolderExpansionKey?: (node: ResourceTreeNode) => string;

  canManageItem?: (node: ResourceTreeNode) => boolean;
}
