/**
 * An open console tab says where its console is: its name (the tab title)
 * and its `Folder/Sub/name` path (the breadcrumb), plus the section it is
 * shown in. Those are the tree's to say. A tab used to take them from
 * whoever renamed or moved the console — the editor's dialog did, the
 * tree's inline rename and drag did not — so after a rename in the tree
 * the breadcrumb kept the old name as if it were a folder, through a
 * reload.
 *
 * So the tab follows the tree: whenever the tree changes, every open tab
 * whose console is in it takes its name and path from there. Only the
 * location — never the content, the saved state or the revision: a tab
 * with unsaved edits keeps them.
 */
export interface TreeConsoleNode {
  id: string;
  name: string;
  isDirectory: boolean;
  children?: TreeConsoleNode[];
}

export interface ConsoleTabLocation {
  title: string;
  filePath: string;
  access: "private" | "workspace";
}

/**
 * Where each console of the tree is. The path is built from the NAMES on
 * the way down, not from a node's stored `path`: right after an inline
 * rename the name is current and the stored path is not.
 */
export function consoleLocationsInTree(
  my: readonly TreeConsoleNode[],
  workspace: readonly TreeConsoleNode[],
): Map<string, ConsoleTabLocation> {
  const out = new Map<string, ConsoleTabLocation>();
  const walk = (
    nodes: readonly TreeConsoleNode[],
    trail: string[],
    access: ConsoleTabLocation["access"],
  ) => {
    for (const node of nodes) {
      if (node.isDirectory) {
        walk(node.children ?? [], [...trail, node.name], access);
      } else if (node.id) {
        out.set(node.id, {
          title: node.name,
          filePath: [...trail, node.name].join("/"),
          access,
        });
      }
    }
  };
  walk(my, [], "private");
  walk(workspace, [], "workspace");
  return out;
}

interface TabLike {
  id: string;
  kind?: string;
  title?: string;
  filePath?: string;
  access?: "private" | "workspace";
  isSaved?: boolean;
}

export interface TabLocationActions {
  updateTitle: (id: string, title: string) => void;
  updateFilePath: (id: string, filePath: string) => void;
  updateAccess: (id: string, access?: "private" | "workspace") => void;
}

/**
 * Point every open, saved console tab at where the tree says its console
 * is. A tab whose console is not in the tree (a draft, a console someone
 * shared, a tree not loaded yet) is left alone. Returns the ids retargeted.
 */
export function retargetConsoleTabs(
  tabs: Record<string, TabLike>,
  locations: ReadonlyMap<string, ConsoleTabLocation>,
  actions: TabLocationActions,
): string[] {
  const changed: string[] = [];
  for (const tab of Object.values(tabs)) {
    if (tab.kind !== undefined && tab.kind !== "console") continue;
    if (tab.isSaved === false) continue;
    const at = locations.get(tab.id);
    if (!at) continue;
    if (
      tab.title === at.title &&
      tab.filePath === at.filePath &&
      tab.access === at.access
    ) {
      continue;
    }
    actions.updateTitle(tab.id, at.title);
    actions.updateFilePath(tab.id, at.filePath);
    actions.updateAccess(tab.id, at.access);
    changed.push(tab.id);
  }
  return changed;
}

/**
 * Close every open tab that shows this console or notebook: the one who
 * deleted it does not need a tab telling them it was deleted (and a dead
 * notebook tab kept asking the server about a notebook that is gone).
 */
export function closeTabsOf(
  store: {
    tabs: Record<string, TabLike & { metadata?: Record<string, unknown> }>;
    closeTab: (id: string) => void;
  },
  target: { consoleId?: string; notebookId?: string },
): string[] {
  const closed: string[] = [];
  for (const tab of Object.values(store.tabs)) {
    const isConsole =
      target.consoleId !== undefined &&
      tab.id === target.consoleId &&
      (tab.kind === undefined || tab.kind === "console");
    const isNotebook =
      target.notebookId !== undefined &&
      tab.kind === "notebook" &&
      tab.metadata?.notebookId === target.notebookId;
    if (isConsole || isNotebook) {
      store.closeTab(tab.id);
      closed.push(tab.id);
    }
  }
  return closed;
}
