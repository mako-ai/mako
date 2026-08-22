/**
 * Apps v2 explorer — drill-down tree of git-backed apps (v1 AppsExplorer
 * parity): each app is a directory node whose children are its file tree
 * (loaded lazily from the durable worktree API), folders expand in place,
 * and every file opens in its own editor tab.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  GitBranch as BranchIcon,
  GitMerge as MergeIcon,
  MoreVertical as KebabIcon,
  Plus as AddIcon,
  Github as LinkIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppsV2Store, type AppV2FileEntry } from "../store/appsV2Store";
import { focusAppsV2FileTab, focusAppsV2Tab } from "../apps-v2-runtime/shell";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { APP_DIR_SEP, APP_FILE_SEP } from "../lib/explorer-reveal";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";

function SectionHeader({
  label,
  open,
  onToggle,
  actions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.5,
        cursor: "pointer",
        userSelect: "none",
        "&:hover .apps-v2-section-actions": { opacity: 1 },
      }}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDownIcon size={14} strokeWidth={2} />
      ) : (
        <ChevronRightIcon size={14} strokeWidth={2} />
      )}
      <Typography
        variant="caption"
        sx={{
          flex: 1,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "text.secondary",
          fontSize: "0.68rem",
        }}
      >
        {label}
      </Typography>
      {actions && (
        <Box
          className="apps-v2-section-actions"
          sx={{
            display: "flex",
            gap: 0,
            opacity: 0,
            transition: "opacity .1s",
          }}
          onClick={e => e.stopPropagation()}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
}

const AppIcon = TAB_KIND_ICONS["app-v2"];

type ParsedNode =
  | { kind: "app"; appId: string; path: "" }
  | { kind: "dir" | "file"; appId: string; path: string };

function parseNodeId(id: string): ParsedNode {
  if (id.includes(APP_FILE_SEP)) {
    const [appId, path] = id.split(APP_FILE_SEP);
    return { kind: "file", appId, path };
  }
  if (id.includes(APP_DIR_SEP)) {
    const [appId, path] = id.split(APP_DIR_SEP);
    return { kind: "dir", appId, path };
  }
  return { kind: "app", appId: id, path: "" };
}

/** Build nested folder/file nodes for one app (mirrors v1 buildAppFileNodes). */
function buildFileNodes(
  appId: string,
  files: AppV2FileEntry[],
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

export default function AppsV2Explorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const apps = useAppsV2Store(s => s.apps);
  const loading = useAppsV2Store(s => s.appsLoading);
  const error = useAppsV2Store(s => s.error);
  const clearError = useAppsV2Store(s => s.clearError);
  const canCreate = useAppsV2Store(s => s.canCreate);
  const repos = useAppsV2Store(s => s.repos);
  const probeEnabled = useAppsV2Store(s => s.probeEnabled);
  const filesByApp = useAppsV2Store(s => s.filesByApp);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const createApp = useAppsV2Store(s => s.createApp);
  const deleteApp = useAppsV2Store(s => s.deleteApp);
  const openGitHubSettings = useCallback(() => {
    const state = useConsoleStore.getState();
    const existing = selectTabBySettingsSection("github")(state);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }
    const id = state.openTab({
      title: SECTION_LABELS.github,
      content: "",
      kind: "settings",
      settingsSection: "github",
    });
    state.setActiveTab(id);
  }, []);

  const activeTab = useConsoleStore(s =>
    s.activeTabId ? s.tabs[s.activeTabId] : undefined,
  );
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "app-v2") {
      return (activeTab.metadata?.appV2Id as string) ?? null;
    }
    if (activeTab?.kind === "app-v2-file") {
      return `${activeTab.metadata?.appV2Id}${APP_FILE_SEP}${activeTab.metadata?.path}`;
    }
    return null;
  }, [activeTab]);

  // The app whose version control this sidebar shows — whichever app-v2 tab
  // (or one of its files) is currently focused, same as Transforms' single
  // "active project" scoping for its Version control section.
  const activeAppId = useMemo(() => {
    if (activeTab?.kind === "app-v2" || activeTab?.kind === "app-v2-file") {
      return (activeTab.metadata?.appV2Id as string) ?? undefined;
    }
    return undefined;
  }, [activeTab]);

  const status = useAppsV2Store(s =>
    activeAppId ? s.statusByApp[activeAppId] : undefined,
  );
  const branches = useAppsV2Store(s =>
    activeAppId ? s.branchesByApp[activeAppId] : undefined,
  );
  const fetchStatus = useAppsV2Store(s => s.fetchStatus);
  const fetchBranches = useAppsV2Store(s => s.fetchBranches);
  const mergeBranch = useAppsV2Store(s => s.mergeBranch);
  const checkoutBranch = useAppsV2Store(s => s.checkoutBranch);
  const commitWork = useAppsV2Store(s => s.commit);
  const editingByApp = useAppsV2Store(s => s.editingByApp);

  // Chat.tsx generates its own MongoDB-ObjectId-shaped chatId client-side and
  // pushes it to realtimeStore (NOT chatStore.currentChatId, which is an
  // unrelated client-only concept for the chat-history sidebar). That real
  // chatId is what apps-v2 tool calls use for `chat/<chatId>` branches.
  const activeChatId = useRealtimeStore(s => s.activeChatId);
  // The conversation you're currently chatting in works on its own
  // `chat/<chatId>` branch (RFC: one branch per conversation). Prefer showing
  // that branch here when it exists for this app — that's what's actually
  // "current" while a chat is in progress, not your own separate (usually
  // untouched) worktree, which always starts on main.
  const activeChatBranchName = activeChatId ? `chat/${activeChatId}` : null;
  const activeChatBranch = branches?.find(b => b.name === activeChatBranchName);

  const reveal = useExplorerRevealStore(selectRevealFor("apps-v2"));

  const [loadingApps, setLoadingApps] = useState<Record<string, boolean>>({});
  // Synthetic org/repo mount nodes default OPEN (their ids are dynamic, so
  // the default lives in the lookup, not the initial state).
  const [expandedFolders, setExpandedFolders] = useState<
    Record<string, boolean>
  >({});
  const isFolderOpen = useCallback(
    (key: string) => expandedFolders[key] ?? false,
    [expandedFolders],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [vcOpen, setVcOpen] = useState(true);
  const [gitMenuAnchor, setGitMenuAnchor] = useState<null | HTMLElement>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    void probeEnabled(workspaceId);
  }, [workspaceId, probeEnabled]);

  // Listing existing apps never depends on the ability to CREATE one — a
  // stale/failed probe must not blank the explorer.
  useEffect(() => {
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

  useEffect(() => {
    if (!workspaceId || !activeAppId) return;
    void fetchStatus(workspaceId, activeAppId);
    void fetchBranches(workspaceId, activeAppId);
  }, [workspaceId, activeAppId, fetchStatus, fetchBranches]);

  const [switching, setSwitching] = useState<string | null>(null);
  const handleCheckout = useCallback(
    async (branch: string) => {
      if (!workspaceId || !activeAppId) return;
      setSwitching(branch);
      setMergeError(null);
      const error = await checkoutBranch(workspaceId, activeAppId, branch);
      setSwitching(null);
      // Refusals are the interesting case — "you have uncommitted changes" is
      // a decision the user has to make, so it stays on screen instead of the
      // menu closing as though the switch happened.
      if (error) setMergeError(error);
      else setGitMenuAnchor(null);
    },
    [workspaceId, activeAppId, checkoutBranch],
  );

  // Committing your own uncommitted work. The agent commits at the end of its
  // turn and Discard throws work away, which between them left no way to KEEP
  // a change you made yourself — so "commit or discard them", the advice git
  // gives and this UI repeated, named an action the UI did not offer.
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const handleCommit = useCallback(async () => {
    if (!workspaceId || !activeAppId || !commitMsg.trim()) return;
    setCommitting(true);
    setMergeError(null);
    const result = await commitWork(workspaceId, activeAppId, commitMsg.trim());
    setCommitting(false);
    if (result.ok) {
      setCommitOpen(false);
      setCommitMsg("");
    } else setMergeError(result.error ?? "Commit failed");
  }, [workspaceId, activeAppId, commitMsg, commitWork]);

  const handleMerge = useCallback(
    async (branch: string) => {
      if (!workspaceId || !activeAppId) return;
      setMerging(branch);
      setMergeError(null);
      const result = await mergeBranch(workspaceId, activeAppId, branch);
      setMerging(null);
      if (!result.ok) setMergeError(result.error ?? "Merge failed");
    },
    [workspaceId, activeAppId, mergeBranch],
  );

  // App rows are directories whose children are the file tree — `undefined`
  // until fetched so ResourceTree shows the loading skeleton and fires
  // onLoadChildren (same contract as the v1 apps explorer).
  const sections = useMemo(() => {
    const appNodes = apps.map(app => ({
      id: app.id,
      name: app.title,
      path: app.id,
      isDirectory: true,
      children: filesByApp[app.id]
        ? buildFileNodes(app.id, filesByApp[app.id])
        : undefined,
    }));
    // §10 monorepo: ONE repo per workspace — the repo is not a tree level.
    // The rail lists apps directly (org/repo grouping died with N-repos).
    return [
      {
        key: "apps",
        label: "Apps",
        nodes: appNodes,
        hideSectionHeader: true,
      },
    ];
  }, [apps, filesByApp]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || filesByApp[parsed.appId]) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      // Live only while editing: the sandbox is already running then, and its
      // uncommitted work is exactly what the tree would otherwise be missing.
      await fetchFiles(workspaceId, parsed.appId, editingByApp[parsed.appId]);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, filesByApp, fetchFiles, editingByApp],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        focusAppsV2Tab(parsed.appId, node.name);
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(
            workspaceId,
            parsed.appId,
            editingByApp[parsed.appId],
          );
        }
      } else if (parsed.kind === "file") {
        focusAppsV2FileTab(parsed.appId, parsed.path);
      }
    },
    [workspaceId, filesByApp, fetchFiles, editingByApp],
  );

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !newTitle.trim()) return;
    setCreating(true);
    const app = await createApp(workspaceId, newTitle.trim());
    setCreating(false);
    if (app) {
      setCreateOpen(false);
      setNewTitle("");
      focusAppsV2Tab(app.id, app.title);
    }
  }, [workspaceId, newTitle, createApp]);

  const handleDelete = useCallback(
    async (appId: string) => {
      if (!workspaceId) return;
      if (
        !window.confirm(
          "Delete this app? Its folder is removed from the workspace repo (history stays in git).",
        )
      ) {
        return;
      }
      await deleteApp(workspaceId, appId);
      const consoleStore = useConsoleStore.getState();
      for (const tab of Object.values(consoleStore.tabs)) {
        if (
          (tab.kind === "app-v2" || tab.kind === "app-v2-file") &&
          tab.metadata?.appV2Id === appId
        ) {
          consoleStore.closeTab(tab.id);
        }
      }
    },
    [workspaceId, deleteApp],
  );

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app") return null;
      return [
        <MenuItem
          key="delete"
          onClick={() => {
            helpers.closeMenu();
            void handleDelete(parsed.appId);
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Delete app
        </MenuItem>,
      ];
    },
    [handleDelete],
  );

  const actions = (
    <>
      <Tooltip title={canCreate ? "New app" : "Link a GitHub repo first"}>
        <span>
          <IconButton
            size="small"
            disabled={!canCreate}
            onClick={() => setCreateOpen(true)}
          >
            <AddIcon size={20} strokeWidth={2} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton
          size="small"
          disabled={loading || !workspaceId}
          onClick={() => workspaceId && fetchApps(workspaceId)}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      {repos.length > 0 && (
        <Tooltip
          title={`Connected: ${repos.map(r => `${r.owner}/${r.repo}`).join(", ")} — manage in Settings`}
        >
          <IconButton size="small" onClick={openGitHubSettings}>
            <LinkIcon size={18} strokeWidth={2} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Apps v2"
        actions={actions}
        searchPlaceholder="Search apps and files..."
        error={error}
        onErrorClose={clearError}
        loading={loading && apps.length === 0}
      >
        {({ searchQuery }) => (
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {activeAppId && (
              <>
                <SectionHeader
                  label="Version control"
                  open={vcOpen}
                  onToggle={() => setVcOpen(o => !o)}
                  actions={
                    <Tooltip title="Branch actions">
                      <IconButton
                        size="small"
                        onClick={e => setGitMenuAnchor(e.currentTarget)}
                      >
                        <KebabIcon size={15} strokeWidth={1.75} />
                      </IconButton>
                    </Tooltip>
                  }
                />
                {vcOpen && (
                  <Box sx={{ px: 1.25, pb: 1 }}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        color: "text.secondary",
                        mb: 0.75,
                        minWidth: 0,
                      }}
                    >
                      <BranchIcon size={13} strokeWidth={1.75} />
                      <Box
                        component="span"
                        sx={{
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {activeChatBranch
                          ? activeChatBranch.name
                          : (status?.branch ?? "main")}
                      </Box>
                      {activeChatBranch && (
                        <Tooltip title="Your active chat conversation is working on this branch">
                          <Chip
                            label="active chat"
                            size="small"
                            color="info"
                            sx={{ height: 16, fontSize: "0.62rem" }}
                          />
                        </Tooltip>
                      )}
                    </Box>
                    {mergeError && (
                      <Alert
                        severity="error"
                        onClose={() => setMergeError(null)}
                        sx={{
                          mb: 1,
                          fontSize: 11,
                          // git's refusals are multi-line and name the files
                          // they are about; collapsing them loses the only
                          // part the reader can act on. Paths have no spaces
                          // to wrap at and this rail is narrow, so let them
                          // break and cap the height rather than let one
                          // message push the tree off screen.
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          "& .MuiAlert-message": {
                            maxHeight: 200,
                            overflowY: "auto",
                          },
                        }}
                      >
                        {mergeError}
                      </Alert>
                    )}
                    {(status?.repoChanges?.length ?? 0) > 0 && (
                      <Box sx={{ mb: 1 }}>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            mb: 0.25,
                          }}
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ flex: 1 }}
                          >
                            {status!.repoChanges.length} uncommitted change
                            {status!.repoChanges.length === 1 ? "" : "s"}
                          </Typography>
                          <Button
                            size="small"
                            sx={{ fontSize: 11, py: 0, minWidth: 0 }}
                            onClick={() => setCommitOpen(true)}
                          >
                            Commit
                          </Button>
                        </Box>
                        {/* Repo-wide and unabbreviated: the file that blocks a
                            branch switch is often one another app's build
                            wrote, and a path trimmed to this app's folder
                            would hide exactly that one. */}
                        {status!.repoChanges.map(change => (
                          <Box
                            key={change.path}
                            title={`${change.status} ${change.path}`}
                            sx={{
                              display: "flex",
                              gap: 0.75,
                              fontFamily: "monospace",
                              fontSize: 10.5,
                              color: "text.secondary",
                              minWidth: 0,
                            }}
                          >
                            <Box component="span">
                              {change.status[0].toUpperCase()}
                            </Box>
                            {/* The status letter sits OUTSIDE the truncating
                                span: `direction: rtl` keeps the end of a long
                                path visible, which is the informative half,
                                but it also reorders anything sharing the
                                element — the letter ended up at the far end
                                and clipped away with the ellipsis. */}
                            <Box
                              component="span"
                              sx={{
                                flex: 1,
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                direction: "rtl",
                                textAlign: "left",
                              }}
                            >
                              {change.path}
                            </Box>
                          </Box>
                        ))}
                      </Box>
                    )}
                    {activeChatBranch && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block" }}
                      >
                        {activeChatBranch.aheadOfMain} commit
                        {activeChatBranch.aheadOfMain === 1 ? "" : "s"} ahead of
                        main
                        {activeChatBranch.lastCommit
                          ? ` · ${activeChatBranch.lastCommit.subject}`
                          : ""}
                      </Typography>
                    )}
                  </Box>
                )}
                <Divider />
              </>
            )}

            {canCreate === false ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Apps v2 apps live in a GitHub repository. Link one to get
                  started — each app is a folder in the repo, each conversation
                  works on its own branch, and publishing merges back to the
                  default branch.
                </Typography>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<LinkIcon size={16} />}
                  sx={{ mt: 1 }}
                  onClick={openGitHubSettings}
                >
                  Link a GitHub repo
                </Button>
              </Box>
            ) : apps.length === 0 && !loading ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No apps yet. Create one, or ask the agent to build one (Apps v2
                tools).
              </Typography>
            ) : (
              <ResourceTree
                sections={sections}
                mode="sidebar"
                searchQuery={searchQuery}
                activeItemId={activeItemId}
                revealNodeId={reveal?.nodeId}
                revealNonce={reveal?.nonce}
                getItemIcon={node =>
                  parseNodeId(node.id).kind === "app" ? (
                    <AppIcon size={16} strokeWidth={1.5} />
                  ) : undefined
                }
                onItemClick={handleItemClick}
                shouldFolderClickActivate={node =>
                  parseNodeId(node.id).kind === "app"
                }
                onLoadChildren={node => void handleLoadChildren(node)}
                isLoadingChildren={node => {
                  const parsed = parseNodeId(node.id);
                  return parsed.kind === "app" && !!loadingApps[parsed.appId];
                }}
                getContextMenuItems={getContextMenuItems}
                enableRename={false}
                enableDelete={false}
                isFolderExpanded={isFolderOpen}
                onToggleFolder={key =>
                  setExpandedFolders(prev => ({ ...prev, [key]: !prev[key] }))
                }
                onExpandFolder={key =>
                  setExpandedFolders(prev => ({ ...prev, [key]: true }))
                }
              />
            )}
          </Box>
        )}
      </ExplorerShell>

      {/* Branch menu */}
      <Menu
        anchorEl={gitMenuAnchor}
        open={Boolean(gitMenuAnchor)}
        onClose={() => setGitMenuAnchor(null)}
      >
        {(branches ?? []).map(branch => {
          const isCurrent = branch.name === status?.branch;
          return (
            <MenuItem
              key={branch.name}
              selected={isCurrent}
              disabled={switching !== null}
              // Selecting a branch checks it out. It used to be inert, which
              // made the menu a list of branches you could look at and not
              // reach — and switching is the whole reason to open it.
              onClick={() => !isCurrent && void handleCheckout(branch.name)}
            >
              {switching === branch.name && (
                <CircularProgress size={12} sx={{ mr: 1 }} />
              )}
              <ListItemText
                primary={
                  isCurrent
                    ? `${branch.name} — current`
                    : branch.isDefault
                      ? `${branch.name} (default)`
                      : `${branch.name} — ${branch.aheadOfMain} ahead`
                }
                secondary={
                  branch.lastCommit
                    ? `${branch.lastCommit.subject} · ${new Date(branch.lastCommit.timestamp).toLocaleString()}`
                    : undefined
                }
              />
              {!branch.isDefault && branch.aheadOfMain > 0 && (
                <Button
                  size="small"
                  sx={{ ml: 2 }}
                  startIcon={
                    merging === branch.name ? (
                      <CircularProgress size={12} />
                    ) : (
                      <MergeIcon size={14} />
                    )
                  }
                  disabled={merging !== null || switching !== null}
                  onClick={event => {
                    // Merging is not switching: without this the row's own
                    // click handler would also fire and check the branch out.
                    event.stopPropagation();
                    void handleMerge(branch.name);
                  }}
                >
                  Merge into main
                </Button>
              )}
            </MenuItem>
          );
        })}
        {(branches ?? []).length === 0 && (
          <MenuItem disabled>No branches</MenuItem>
        )}
      </Menu>

      <Dialog
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New Apps v2 app</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Title"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleCreate();
            }}
            disabled={creating}
          />
          <Typography variant="caption" color="text.secondary">
            {repos.length > 0
              ? `Creates a real Vite + React project in the connected GitHub repo (${repos[0].owner}/${repos[0].repo}).`
              : "Creates a real Vite + React project in Mako-hosted cloud storage — no GitHub setup needed."}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreate()}
            disabled={creating || !newTitle.trim()}
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={commitOpen}
        onClose={() => !committing && setCommitOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Commit changes</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Message"
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleCommit();
            }}
            disabled={committing}
          />
          <Typography variant="caption" color="text.secondary">
            Commits all {status?.repoChanges?.length ?? 0} uncommitted change
            {(status?.repoChanges?.length ?? 0) === 1 ? "" : "s"} onto{" "}
            {status?.branch ?? "your branch"}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCommitOpen(false)} disabled={committing}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCommit()}
            disabled={committing || !commitMsg.trim()}
          >
            {committing ? "Committing..." : "Commit"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
