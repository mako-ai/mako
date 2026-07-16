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
  Autocomplete,
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

/**
 * Synthetic nodes grouping apps under their storage mount, connector-tab
 * style: an org node (GitHub avatar) containing a repo node (GitHub mark)
 * containing the apps — or a single "Mako Cloud" node when no repo is
 * connected. Purely presentational: neither has a backend identity. The
 * suffix after the prefix carries the org login / repo name for icon lookup.
 */
const ORG_NODE_PREFIX = "::org::";
const REPO_NODE_PREFIX = "::repo::";
const CLOUD_NODE_ID = "::mako-cloud::";

type ParsedNode =
  | { kind: "org" | "repo"; appId: ""; path: string }
  | { kind: "app"; appId: string; path: "" }
  | { kind: "dir" | "file"; appId: string; path: string };

function parseNodeId(id: string): ParsedNode {
  if (id.startsWith(ORG_NODE_PREFIX)) {
    return { kind: "org", appId: "", path: id.slice(ORG_NODE_PREFIX.length) };
  }
  if (id === CLOUD_NODE_ID) {
    return { kind: "repo", appId: "", path: "" };
  }
  if (id.startsWith(REPO_NODE_PREFIX)) {
    return { kind: "repo", appId: "", path: id.slice(REPO_NODE_PREFIX.length) };
  }
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
  const fetchGithubBranches = useAppsV2Store(s => s.fetchGithubBranches);
  const connectRepo = useAppsV2Store(s => s.connectRepo);
  const disconnectRepo = useAppsV2Store(s => s.disconnectRepo);
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
    (key: string) =>
      expandedFolders[key] ??
      (key.startsWith(ORG_NODE_PREFIX) ||
        key.startsWith(REPO_NODE_PREFIX) ||
        key === CLOUD_NODE_ID),
    [expandedFolders],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [vcOpen, setVcOpen] = useState(true);
  const [gitMenuAnchor, setGitMenuAnchor] = useState<null | HTMLElement>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Repo-node kebab: menu anchor + which repo it targets; branch switcher.
  const [repoMenu, setRepoMenu] = useState<{
    anchor: HTMLElement;
    repoKey: string;
  } | null>(null);
  const [switchRepoKey, setSwitchRepoKey] = useState<string | null>(null);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [switchBranch, setSwitchBranch] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    void probeEnabled(workspaceId);
  }, [workspaceId, probeEnabled]);

  useEffect(() => {
    if (workspaceId && canCreate) void fetchApps(workspaceId);
  }, [workspaceId, canCreate, fetchApps]);

  useEffect(() => {
    if (!workspaceId || !activeAppId) return;
    void fetchStatus(workspaceId, activeAppId);
    void fetchBranches(workspaceId, activeAppId);
  }, [workspaceId, activeAppId, fetchStatus, fetchBranches]);

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
    // Group apps under their storage mount so the hierarchy reads like the
    // repo they (will) live in: org (avatar) > repo (GitHub mark) > apps.
    // Until apps carry a per-repo pointer (substrate pivot pending), they all
    // nest under the first connected repo; extra repos render empty.
    const orgNodes = repos.map((repo, index) => ({
      id: `${ORG_NODE_PREFIX}${repo.owner}/${repo.repo}`,
      name: repo.owner,
      path: repo.owner,
      isDirectory: true,
      children: [
        {
          id: `${REPO_NODE_PREFIX}${repo.owner}/${repo.repo}`,
          name: repo.repo,
          path: `${repo.owner}/${repo.repo}`,
          isDirectory: true,
          children: index === 0 ? appNodes : [],
        },
      ],
    }));
    return [
      {
        key: "apps",
        label: "Apps",
        nodes: orgNodes.length
          ? orgNodes
          : [
              {
                id: CLOUD_NODE_ID,
                name: "Mako Cloud",
                path: CLOUD_NODE_ID,
                isDirectory: true,
                children: appNodes,
              },
            ],
        hideSectionHeader: true,
      },
    ];
  }, [apps, filesByApp, repos]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind !== "app" || !workspaceId || filesByApp[parsed.appId]) {
        return;
      }
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: true }));
      await fetchFiles(workspaceId, parsed.appId);
      setLoadingApps(prev => ({ ...prev, [parsed.appId]: false }));
    },
    [workspaceId, filesByApp, fetchFiles],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "app") {
        focusAppsV2Tab(parsed.appId, node.name);
        // Warm the file tree so expanding is instant.
        if (workspaceId && !filesByApp[parsed.appId]) {
          void fetchFiles(workspaceId, parsed.appId);
        }
      } else if (parsed.kind === "file") {
        focusAppsV2FileTab(parsed.appId, parsed.path);
      }
    },
    [workspaceId, filesByApp, fetchFiles],
  );

  const repoByKey = useCallback(
    (key: string | null) =>
      key ? repos.find(r => `${r.owner}/${r.repo}` === key) : undefined,
    [repos],
  );

  const openSwitchBranch = useCallback(
    async (repoKey: string) => {
      const repo = repoByKey(repoKey);
      if (!workspaceId || !repo) return;
      setRepoMenu(null);
      setSwitchRepoKey(repoKey);
      setSwitchBranch(repo.defaultBranch);
      setBranchesLoading(true);
      setBranchOptions(
        await fetchGithubBranches(
          workspaceId,
          repo.owner,
          repo.repo,
          repo.installationId,
        ),
      );
      setBranchesLoading(false);
    },
    [workspaceId, repoByKey, fetchGithubBranches],
  );

  const handleSwitchBranch = useCallback(async () => {
    const repo = repoByKey(switchRepoKey);
    if (!workspaceId || !repo || !switchBranch) return;
    setSwitching(true);
    // Re-saving the binding with a new default branch — the branch
    // conversations fork from and publish merges into for this repo.
    await connectRepo(workspaceId, {
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch: switchBranch,
      subdirectory: repo.subdirectory,
      installationId: repo.installationId,
    });
    setSwitching(false);
    setSwitchRepoKey(null);
  }, [workspaceId, repoByKey, switchRepoKey, switchBranch, connectRepo]);

  const handleDisconnectRepo = useCallback(
    async (repoKey: string) => {
      const repo = repoByKey(repoKey);
      setRepoMenu(null);
      if (!workspaceId || !repo) return;
      if (
        !window.confirm(
          `Disconnect ${repo.owner}/${repo.repo}? Its content stays in GitHub; this workspace just stops pointing at it.`,
        )
      ) {
        return;
      }
      await disconnectRepo(workspaceId, repo.owner, repo.repo);
    },
    [workspaceId, repoByKey, disconnectRepo],
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
          "Delete this app and its git repository? This cannot be undone.",
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
                        sx={{ mb: 1, fontSize: 12 }}
                      >
                        {mergeError}
                      </Alert>
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
                getItemIcon={node => {
                  const parsed = parseNodeId(node.id);
                  if (parsed.kind === "app") {
                    return <AppIcon size={16} strokeWidth={1.5} />;
                  }
                  if (parsed.kind === "repo") {
                    return <LinkIcon size={16} strokeWidth={1.5} />;
                  }
                  if (parsed.kind === "org") {
                    const owner = parsed.path.split("/")[0];
                    return (
                      <Box
                        component="img"
                        src={`https://github.com/${owner}.png?size=32`}
                        alt={`${owner} avatar`}
                        sx={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          display: "block",
                          flexShrink: 0,
                        }}
                      />
                    );
                  }
                  return undefined;
                }}
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
                getRightAdornment={node => {
                  const parsed = parseNodeId(node.id);
                  if (parsed.kind !== "repo" || node.id === CLOUD_NODE_ID) {
                    return null;
                  }
                  const repo = repoByKey(parsed.path);
                  if (!repo) return null;
                  return (
                    <Box
                      sx={{ display: "flex", alignItems: "center", gap: 0.25 }}
                      onClick={e => e.stopPropagation()}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {repo.defaultBranch}
                      </Typography>
                      <IconButton
                        size="small"
                        sx={{ p: 0.25 }}
                        onClick={e => {
                          e.stopPropagation();
                          setRepoMenu({
                            anchor: e.currentTarget,
                            repoKey: parsed.path,
                          });
                        }}
                      >
                        <KebabIcon size={14} strokeWidth={1.75} />
                      </IconButton>
                    </Box>
                  );
                }}
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

      {/* Repo-node kebab menu */}
      <Menu
        anchorEl={repoMenu?.anchor ?? null}
        open={Boolean(repoMenu)}
        onClose={() => setRepoMenu(null)}
      >
        <MenuItem
          onClick={() => repoMenu && void openSwitchBranch(repoMenu.repoKey)}
        >
          <ListItemIcon>
            <BranchIcon size={16} />
          </ListItemIcon>
          Switch branch…
        </MenuItem>
        <MenuItem
          component="a"
          href={`https://github.com/${repoMenu?.repoKey ?? ""}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setRepoMenu(null)}
        >
          <ListItemIcon>
            <LinkIcon size={16} />
          </ListItemIcon>
          Open on GitHub
        </MenuItem>
        <MenuItem
          onClick={() =>
            repoMenu && void handleDisconnectRepo(repoMenu.repoKey)
          }
        >
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Disconnect repo
        </MenuItem>
      </Menu>

      {/* Switch-branch dialog */}
      <Dialog
        open={Boolean(switchRepoKey)}
        onClose={() => setSwitchRepoKey(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Switch branch — {switchRepoKey}</DialogTitle>
        <DialogContent>
          <Autocomplete
            options={branchOptions}
            loading={branchesLoading}
            value={switchBranch}
            onChange={(_, v) => setSwitchBranch(v)}
            renderInput={params => (
              <TextField
                {...params}
                margin="dense"
                label="Branch"
                placeholder={branchesLoading ? "Loading branches…" : "Branch"}
              />
            )}
          />
          <Typography variant="caption" color="text.secondary">
            Conversations fork from this branch and publishing merges back into
            it.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSwitchRepoKey(null)} disabled={switching}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSwitchBranch()}
            disabled={switching || !switchBranch}
          >
            {switching ? "Switching…" : "Switch"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Branch menu */}
      <Menu
        anchorEl={gitMenuAnchor}
        open={Boolean(gitMenuAnchor)}
        onClose={() => setGitMenuAnchor(null)}
      >
        {(branches ?? []).map(branch => (
          <MenuItem key={branch.name} disableRipple sx={{ cursor: "default" }}>
            <ListItemText
              primary={
                branch.isDefault
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
                disabled={merging !== null}
                onClick={() => void handleMerge(branch.name)}
              >
                Merge into main
              </Button>
            )}
          </MenuItem>
        ))}
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
    </>
  );
}
