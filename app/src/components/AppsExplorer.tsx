import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  MenuItem,
  ListItemIcon,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  AppWindow as AppIcon,
  FileCode as CodeFileIcon,
  FileText as TextFileIcon,
  File as PlainFileIcon,
  Braces as JsonFileIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Database as BindingIcon,
  Globe as GlobeIcon,
  User as UserIcon,
  Lock as LockIcon,
  ExternalLink as OpenIcon,
  Pencil as RenameIcon,
  Trash2 as DeleteIcon,
  Database as MaterializeIcon,
  History as HistoryIcon,
  Save as SaveVersionIcon,
} from "lucide-react";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { useAppStore, type AppListItem } from "../store/appStore";
import { useVersionStore } from "../store/versionStore";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import {
  APP_FILE_SEP as FILE_SEP,
  APP_DIR_SEP as DIR_SEP,
  APP_BINDING_SEP as BINDING_SEP,
} from "../lib/explorer-reveal";
import {
  focusAppTab,
  focusAppFileTab,
  focusAppBindingTab,
} from "../app-runtime/shell";
import type { AppFile } from "@mako/schemas";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

const EMPTY_LIST: AppListItem[] = [];

// Node id encoding so the flat ResourceTree ids stay unique and parseable.
// App node:     "<appId>"
// Folder node:  "<appId>::dir::<dirPath>"
// File node:    "<appId>::file::<filePath>"
// Binding node: "<appId>::binding::<bindingId>"
// (separators are shared with lib/explorer-reveal so reveal ids never drift)
const DATA_SOURCES_DIR = "__datasources";

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

// Per-extension file icons, mirroring the database explorer's per-kind icons.
const CODE_FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "css",
  "scss",
  "html",
]);
function fileIcon(name: string) {
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

interface ParsedNode {
  kind: "app" | "dir" | "file" | "binding";
  appId: string;
  path: string;
}
function parseNodeId(id: string): ParsedNode {
  if (id.includes(BINDING_SEP)) {
    const [appId, path] = id.split(BINDING_SEP);
    return { kind: "binding", appId, path };
  }
  if (id.includes(FILE_SEP)) {
    const [appId, path] = id.split(FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(DIR_SEP)) {
    const [appId, path] = id.split(DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, path: "" };
}

/** Build nested ResourceTree nodes (folders + files) for one app's files. */
function buildAppFileNodes(
  appId: string,
  files: AppFile[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${appId}${DIR_SEP}`,
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
        ? `${appId}${FILE_SEP}${path}`
        : `${appId}${DIR_SEP}${path}`;
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

export function AppsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const isAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  const myApps = useAppStore(
    s => (workspaceId ? s.myApps[workspaceId] : undefined) || EMPTY_LIST,
  );
  const workspaceApps = useAppStore(
    s => (workspaceId ? s.workspaceApps[workspaceId] : undefined) || EMPTY_LIST,
  );
  const openApps = useAppStore(s => s.openApps);
  const loading = useAppStore(s =>
    workspaceId ? !!s.loading[workspaceId] : false,
  );
  const error = useAppStore(s => (workspaceId ? s.error[workspaceId] : null));
  const fetchList = useAppStore(s => s.fetchList);
  const fetchApp = useAppStore(s => s.fetchApp);
  const createApp = useAppStore(s => s.createApp);
  const deleteApp = useAppStore(s => s.deleteApp);
  const renameApp = useAppStore(s => s.renameApp);
  const renameFile = useAppStore(s => s.renameFile);
  const deleteFile = useAppStore(s => s.deleteFile);
  const removeDataBinding = useAppStore(s => s.removeDataBinding);
  const materializeBinding = useAppStore(s => s.materializeBinding);
  const persistApp = useAppStore(s => s.persistApp);
  const setAppAccess = useAppStore(s => s.setAppAccess);
  const bumpPreview = useAppStore(s => s.bumpPreview);
  const saveVersion = useVersionStore(s => s.saveVersion);

  const activeTabId = useConsoleStore(s => s.activeTabId);
  const tabs = useConsoleStore(s => s.tabs);
  const activeTab = activeTabId ? tabs[activeTabId] : undefined;
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "app") return activeTab.metadata?.appId as string;
    if (activeTab?.kind === "app-file") {
      return `${activeTab.metadata?.appId}${FILE_SEP}${activeTab.metadata?.path}`;
    }
    if (activeTab?.kind === "app-binding") {
      return `${activeTab.metadata?.appId}${BINDING_SEP}${activeTab.metadata?.bindingId}`;
    }
    return null;
  }, [activeTab]);

  const reveal = useExplorerRevealStore(selectRevealFor("apps"));

  const expandedFolders = useExplorerStore(s => s.app.expandedFolders);
  const toggleAppFolder = useExplorerStore(s => s.toggleAppFolder);
  const expandAppFolder = useExplorerStore(s => s.expandAppFolder);
  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  const [renameTarget, setRenameTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);
  // Version history: which app's history drawer is open.
  const [historyApp, setHistoryApp] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Save-version dialog state.
  const [saveVersionApp, setSaveVersionApp] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [saveVersionComment, setSaveVersionComment] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);

  useEffect(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  // Build the section node trees. App nodes are directories whose children are
  // the file tree (undefined until the app is fetched, so ResourceTree shows a
  // loading skeleton and fires onLoadChildren).
  const buildSectionNodes = useCallback(
    (items: AppListItem[]): ResourceTreeNode[] =>
      items.map(item => {
        const loaded = openApps[item.id];
        let children: ResourceTreeNode[] | undefined;
        if (loaded) {
          children = buildAppFileNodes(item.id, loaded.files);
          children.push({
            id: `${item.id}${DIR_SEP}${DATA_SOURCES_DIR}`,
            name: "Data sources",
            path: DATA_SOURCES_DIR,
            isDirectory: true,
            entityType: "data-source-folder",
            children: loaded.dataBindings.map(b => ({
              id: `${item.id}${BINDING_SEP}${b.id}`,
              name: b.name,
              path: `binding/${b.id}`,
              isDirectory: false,
              entityType: "data-source",
            })),
          });
        }
        return {
          id: item.id,
          name: item.name,
          path: item.id,
          isDirectory: true,
          access: item.access,
          owner_id: item.owner_id,
          children,
        };
      }),
    [openApps],
  );

  const sections = useMemo(
    () => [
      {
        key: "my",
        label: "My Apps",
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: buildSectionNodes(myApps),
        droppableId: "__section_my",
        defaultAccess: "private" as const,
      },
      {
        key: "workspace",
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: buildSectionNodes(workspaceApps),
        droppableId: "__section_workspace",
        defaultAccess: "workspace" as const,
      },
    ],
    [myApps, workspaceApps, buildSectionNodes],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId) return;
    const created = await createApp(workspaceId, "Untitled App");
    if (created) focusAppTab(created._id, created.title);
  }, [workspaceId, createApp]);

  const handleRefresh = useCallback(() => {
    if (workspaceId) void fetchList(workspaceId);
  }, [workspaceId, fetchList]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || openApps[parsed.appId]) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      await fetchApp(workspaceId, parsed.appId);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, openApps, fetchApp],
  );

  const handleItemClick = useCallback((node: ResourceTreeNode) => {
    const parsed = parseNodeId(node.id);
    if (parsed.kind === "app") focusAppTab(parsed.appId, node.name);
    else if (parsed.kind === "file") {
      focusAppFileTab(parsed.appId, parsed.path);
    } else if (parsed.kind === "binding") {
      focusAppBindingTab(parsed.appId, parsed.path, node.name);
    }
  }, []);

  // Clicking an app *name* opens the app preview tab; the caret (and the
  // indent left of it) still expands/collapses the app's file sub-tree.
  // Mirrors the database explorer's table behavior.
  const shouldFolderClickActivate = useCallback(
    (node: ResourceTreeNode) => parseNodeId(node.id).kind === "app",
    [],
  );

  // Only app rows are draggable / manageable through the tree itself; files
  // and folders inside an app are edited through their own tabs.
  const canManageNode = useCallback(
    (node: ResourceTreeNode) => {
      if (parseNodeId(node.id).kind !== "app") return false;
      return isAdmin || node.owner_id === user?.id;
    },
    [isAdmin, user?.id],
  );

  // Which section an app currently lives in (drives drop no-op detection).
  const sectionAccessOfApp = useCallback(
    (appId: string): "private" | "workspace" | null => {
      if (myApps.some(item => item.id === appId)) return "private";
      if (workspaceApps.some(item => item.id === appId)) return "workspace";
      return null;
    },
    [myApps, workspaceApps],
  );

  // Drag an app onto the "My Apps" / "Workspace" section (or onto any node
  // inside it) to change its sharing. Drops within the same section no-op.
  const handleMoveNode = useCallback(
    (nodeId: string, targetId: string | null, access?: string) => {
      if (!workspaceId) return;
      const parsed = parseNodeId(nodeId);
      if (parsed.kind !== "app") return;
      let nextAccess: "private" | "workspace" | null =
        access === "private" || access === "workspace" ? access : null;
      if (!nextAccess && targetId) {
        nextAccess = sectionAccessOfApp(parseNodeId(targetId).appId);
      }
      if (!nextAccess || sectionAccessOfApp(parsed.appId) === nextAccess) {
        return;
      }
      void setAppAccess(workspaceId, parsed.appId, nextAccess);
    },
    [workspaceId, sectionAccessOfApp, setAppAccess],
  );

  // Dimmed file count on app rows, like the database explorer's group counts.
  const fileCountByAppId = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of [...myApps, ...workspaceApps]) {
      map.set(item.id, item.fileCount);
    }
    return map;
  }, [myApps, workspaceApps]);

  const getRightAdornment = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app") return null;
      const count = fileCountByAppId.get(parsed.appId);
      if (count === undefined) return null;
      return (
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", whiteSpace: "nowrap" }}
        >
          {count}
        </Typography>
      );
    },
    [fileCountByAppId],
  );

  const getItemIcon = useCallback(
    (node: ResourceTreeNode, ctx?: { isExpanded: boolean }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        return <AppIcon size={16} strokeWidth={1.5} />;
      }
      if (parsed.kind === "file") {
        return fileIcon(node.name);
      }
      if (parsed.kind === "binding") {
        return <BindingIcon size={16} strokeWidth={1.5} />;
      }
      return ctx?.isExpanded ? (
        <FolderOpenIcon size={16} strokeWidth={1.5} />
      ) : (
        <FolderIcon size={16} strokeWidth={1.5} />
      );
    },
    [],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "dir") return []; // virtual folders: no actions
      const items = [];
      const open = () => {
        if (parsed.kind === "app") focusAppTab(parsed.appId, node.name);
        else if (parsed.kind === "binding") {
          focusAppBindingTab(parsed.appId, parsed.path, node.name);
        } else focusAppFileTab(parsed.appId, parsed.path);
      };
      items.push(
        <MenuItem
          key="open"
          onClick={() => {
            open();
            helpers.closeMenu();
          }}
        >
          <ListItemIcon>
            <OpenIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Open
        </MenuItem>,
      );

      // Share / unshare — the menu twin of dragging the app between the
      // "My Apps" and "Workspace" sections.
      if (parsed.kind === "app" && workspaceId && canManageNode(node)) {
        const isShared = node.access === "workspace";
        items.push(
          <MenuItem
            key="share"
            onClick={() => {
              void setAppAccess(
                workspaceId,
                parsed.appId,
                isShared ? "private" : "workspace",
              );
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              {isShared ? (
                <LockIcon size={16} strokeWidth={1.5} />
              ) : (
                <GlobeIcon size={16} strokeWidth={1.5} />
              )}
            </ListItemIcon>
            {isShared ? "Move to My Apps" : "Move to Workspace"}
          </MenuItem>,
        );
      }

      // Version history (read) + save checkpoint (write) for apps.
      if (parsed.kind === "app") {
        items.push(
          <MenuItem
            key="history"
            onClick={() => {
              setHistoryApp({ id: parsed.appId, name: node.name });
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <HistoryIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Version history
          </MenuItem>,
        );
        if (canManageNode(node)) {
          items.push(
            <MenuItem
              key="save-version"
              onClick={() => {
                setSaveVersionApp({ id: parsed.appId, name: node.name });
                setSaveVersionComment("");
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <SaveVersionIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Publish version
            </MenuItem>,
          );
        }
      }

      // Materialize action for parquet bindings.
      if (parsed.kind === "binding" && workspaceId) {
        const appEntity = openApps[parsed.appId];
        const binding = appEntity?.dataBindings.find(b => b.id === parsed.path);
        if (binding?.materialization === "parquet") {
          items.push(
            <MenuItem
              key="materialize"
              onClick={() => {
                void materializeBinding(
                  workspaceId,
                  parsed.appId,
                  parsed.path,
                  { force: true },
                );
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <MaterializeIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Materialize
            </MenuItem>,
          );
        }
      }

      // Bindings can be renamed via the inspector; only apps/files rename here.
      if (parsed.kind !== "binding") {
        items.push(
          <MenuItem
            key="rename"
            onClick={() => {
              setRenameTarget({ parsed, name: node.name });
              setRenameValue(node.name);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <RenameIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Rename
          </MenuItem>,
        );
      }
      items.push(
        <MenuItem
          key="delete"
          onClick={() => {
            setDeleteTarget({ parsed, name: node.name });
            helpers.closeMenu();
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Delete
        </MenuItem>,
      );
      return items;
    },
    [workspaceId, openApps, materializeBinding, canManageNode, setAppAccess],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget || !workspaceId) return;
    const next = renameValue.trim();
    const { parsed } = renameTarget;
    if (next && next !== renameTarget.name) {
      if (parsed.kind === "app") {
        await renameApp(workspaceId, parsed.appId, next);
      } else if (parsed.kind === "file") {
        const dir = dirname(parsed.path);
        const newPath = dir ? `${dir}/${next}` : next;
        renameFile(parsed.appId, parsed.path, newPath);
        await persistApp(workspaceId, parsed.appId);
      }
    }
    setRenameTarget(null);
  }, [
    renameTarget,
    renameValue,
    workspaceId,
    renameApp,
    renameFile,
    persistApp,
  ]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    const { parsed } = deleteTarget;
    if (parsed.kind === "app") {
      await deleteApp(workspaceId, parsed.appId);
    } else if (parsed.kind === "file") {
      deleteFile(parsed.appId, parsed.path);
      await persistApp(workspaceId, parsed.appId);
    } else if (parsed.kind === "binding") {
      removeDataBinding(parsed.appId, parsed.path);
      await persistApp(workspaceId, parsed.appId);
    }
    setDeleteTarget(null);
  }, [
    deleteTarget,
    workspaceId,
    deleteApp,
    deleteFile,
    removeDataBinding,
    persistApp,
  ]);

  const handleSaveVersionConfirm = useCallback(async () => {
    if (!saveVersionApp || !workspaceId) return;
    setSavingVersion(true);
    // Flush any pending local edits so the checkpoint matches what's on screen.
    if (openApps[saveVersionApp.id]) {
      await persistApp(workspaceId, saveVersionApp.id);
    }
    await saveVersion(
      workspaceId,
      "app",
      saveVersionApp.id,
      saveVersionComment.trim(),
    );
    setSavingVersion(false);
    setSaveVersionApp(null);
  }, [
    saveVersionApp,
    workspaceId,
    openApps,
    persistApp,
    saveVersion,
    saveVersionComment,
  ]);

  const actions = (
    <>
      <Tooltip title="New App">
        <IconButton size="small" onClick={handleCreate}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh} disabled={loading}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const isApp = renameTarget?.parsed.kind === "app";
  const deleteKindLabel =
    deleteTarget?.parsed.kind === "app"
      ? "App"
      : deleteTarget?.parsed.kind === "binding"
        ? "Data source"
        : "File";

  return (
    <>
      <ExplorerShell
        title="Apps"
        actions={actions}
        searchPlaceholder="Search apps..."
        error={error}
        onErrorClose={() => {
          if (workspaceId) {
            useAppStore.setState(state => {
              state.error[workspaceId] = null;
            });
          }
        }}
        loading={loading && myApps.length === 0 && workspaceApps.length === 0}
        skeleton={
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        }
      >
        {({ searchQuery }) => (
          <ResourceTree
            sections={sections}
            mode="sidebar"
            searchQuery={searchQuery}
            activeItemId={activeItemId}
            revealNodeId={reveal?.nodeId}
            revealNonce={reveal?.nonce}
            getItemIcon={getItemIcon}
            getRightAdornment={getRightAdornment}
            getContextMenuItems={getContextMenuItems}
            onItemClick={handleItemClick}
            shouldFolderClickActivate={shouldFolderClickActivate}
            onLoadChildren={handleLoadChildren}
            isLoadingChildren={node => {
              const parsed = parseNodeId(node.id);
              return parsed.kind === "app" && !!loadingApps[parsed.appId];
            }}
            enableDragDrop
            onMoveItem={handleMoveNode}
            onMoveFolder={handleMoveNode}
            canManageItem={canManageNode}
            enableRename={false}
            enableDelete={false}
            enableNewFolder={false}
            isFolderExpanded={key => !!expandedFolders[key]}
            onToggleFolder={toggleAppFolder}
            onExpandFolder={expandAppFolder}
            getFolderExpansionKey={node => node.id}
          />
        )}
      </ExplorerShell>

      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Rename {isApp ? "App" : "File"}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleRenameConfirm();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button onClick={handleRenameConfirm}>Rename</Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete {deleteKindLabel}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            {deleteTarget?.parsed.kind === "app"
              ? " This deletes the entire app."
              : ""}{" "}
            This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Save version dialog */}
      <Dialog
        open={!!saveVersionApp}
        onClose={() => !savingVersion && setSaveVersionApp(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Publish version of {saveVersionApp?.name}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Snapshots the current draft into version history and publishes it as
            the live version that shared links and viewers see.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Comment (optional)"
            placeholder="e.g. Add revenue chart"
            value={saveVersionComment}
            onChange={e => setSaveVersionComment(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleSaveVersionConfirm();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setSaveVersionApp(null)}
            disabled={savingVersion}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveVersionConfirm}
            variant="contained"
            disabled={savingVersion}
          >
            {savingVersion ? "Publishing..." : "Publish version"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Version history drawer */}
      {historyApp && (
        <VersionHistoryPanel
          open={!!historyApp}
          onClose={() => setHistoryApp(null)}
          entityType="app"
          entityId={historyApp.id}
          onRestore={() => {
            if (workspaceId && historyApp) {
              void fetchApp(workspaceId, historyApp.id).then(() =>
                bumpPreview(historyApp.id),
              );
            }
          }}
        />
      )}
    </>
  );
}

export default AppsExplorer;
