/**
 * Source Control — the workspace repository, VS Code style.
 *
 * The left rail entry this lives behind uses the git-branch icon that used to
 * stand for Transforms; now it means what it says. The panel is VS Code's SCM
 * anatomy on Mako's data: CHANGES (commit message, Commit button, the
 * uncommitted files with their status letters) and GRAPH (the branch's
 * history, current branch pinned as a badge on the newest commit).
 *
 * One deliberate difference from the per-app Version Control section: this is
 * the WHOLE workspace repo. One working copy serves every app, so the changes
 * listed here are the repo-wide set — the same set a branch switch has to get
 * past, which the app-scoped view once hid.
 *
 * The apps API is addressed per app, but status/commit/history all operate
 * on the workspace repo, so any app id works as a handle; the first one
 * serves. No apps yet means no repo to control.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  GitBranch as BranchIcon,
  GitMerge as MergeIcon,
  Github as GitHubIcon,
  Minus as MinusIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  RotateCcw as DiscardIcon,
  SquareArrowOutUpRight as OpenFileIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsStore, type AppChange } from "../store/appsStore";
import {
  useConsoleStore,
  selectTabBySettingsSection,
} from "../store/consoleStore";
import { SECTION_LABELS } from "../pages/settings/sections";
import { focusAppsDiffTab, focusAppsFileTab } from "../apps-runtime/shell";
import VSScrollArea from "./VSScrollArea";

/** VS Code's status letters, in VS Code's colors. */
const STATUS_STYLE: Record<
  AppChange["status"],
  { letter: string; color: string }
> = {
  modified: { letter: "M", color: "#e2c08d" },
  added: { letter: "A", color: "#81c995" },
  deleted: { letter: "D", color: "#f28b82" },
  renamed: { letter: "R", color: "#81c995" },
};

function Section({
  label,
  open,
  onToggle,
  actions,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: "pointer",
          userSelect: "none",
          "&:hover .scm-actions": { opacity: 1 },
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
            className="scm-actions"
            sx={{ display: "flex", gap: 0.25, opacity: 0.35 }}
            onClick={e => e.stopPropagation()}
          >
            {actions}
          </Box>
        )}
      </Box>
      {open && children}
    </>
  );
}

/** A small icon button that only shows on row hover (VS Code's inline actions). */
function RowAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={title}>
      <IconButton
        size="small"
        sx={{ p: 0.25, borderRadius: 0.5 }}
        onClick={e => {
          e.stopPropagation();
          onClick();
        }}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

/**
 * One changed file, VS Code style: name bright, directory dimmed, status
 * letter, inline actions on hover; clicking the row opens its diff.
 */
function ChangeRow({
  change,
  onOpen,
  actions,
}: {
  change: AppChange;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  const slash = change.path.lastIndexOf("/");
  const name = slash === -1 ? change.path : change.path.slice(slash + 1);
  const dir = slash === -1 ? "" : change.path.slice(0, slash);
  const style = STATUS_STYLE[change.status];
  return (
    <Box
      title={`${change.status}: ${change.path}`}
      onClick={onOpen}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        px: 2,
        py: 0.25,
        minWidth: 0,
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
        "&:hover .scm-row-actions": { display: "flex" },
        "&:hover .scm-row-letter": { display: "none" },
      }}
    >
      <Box
        component="span"
        sx={{
          flexShrink: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
        }}
      >
        {name}
      </Box>
      {dir && (
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
            fontSize: 11.5,
            color: "text.disabled",
          }}
        >
          {dir}
        </Box>
      )}
      <Box
        className="scm-row-actions"
        sx={{ ml: "auto", display: "none", gap: 0, flexShrink: 0 }}
      >
        {actions}
      </Box>
      <Box
        className="scm-row-letter"
        component="span"
        sx={{
          ml: "auto",
          fontSize: 12,
          fontWeight: 600,
          color: style.color,
          flexShrink: 0,
        }}
      >
        {style.letter}
      </Box>
    </Box>
  );
}

export default function SourceControlExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const apps = useAppsStore(s => s.apps);
  const fetchApps = useAppsStore(s => s.fetchApps);
  const statusByApp = useAppsStore(s => s.statusByApp);
  const historyByApp = useAppsStore(s => s.repoHistoryByApp);
  const fetchStatus = useAppsStore(s => s.fetchStatus);
  const fetchHistory = useAppsStore(s => s.fetchHistory);
  const commit = useAppsStore(s => s.commit);

  // Any app id reaches the workspace repo; the first one is the handle.
  const appId = apps[0]?.id;
  const status = appId ? statusByApp[appId] : undefined;
  const history = appId ? historyByApp[appId] : undefined;
  const changes = useMemo(() => status?.repoChanges ?? [], [status]);
  // VS Code's two groups. A file can be in both (staged, then edited again).
  // Older status payloads carry no flags: treat them as unstaged.
  const staged = useMemo(() => changes.filter(c => c.staged), [changes]);
  const unstaged = useMemo(
    () => changes.filter(c => c.unstaged ?? !c.staged),
    [changes],
  );
  const gitPaths = useAppsStore(s => s.gitPaths);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    paths: string[];
  } | null>(null);
  const [acting, setActing] = useState(false);

  const runGit = useCallback(
    async (action: "stage" | "unstage" | "discard", paths: string[]) => {
      if (!workspaceId || !appId || paths.length === 0) return;
      setActing(true);
      setError(null);
      const result = await gitPaths(workspaceId, appId, action, paths);
      setActing(false);
      if (!result.ok) setError(result.error ?? `Could not ${action}`);
    },
    [workspaceId, appId, gitPaths],
  );

  // Opening a change = its diff (VS Code's "Open Changes"); the inline
  // "Open File" action opens the editor instead, when the path is an app's.
  const ownerOf = useCallback(
    (path: string) => {
      for (const app of apps) {
        if (app.slug && path.startsWith(`apps/${app.slug}/`)) {
          return { app, rel: path.slice(`apps/${app.slug}/`.length) };
        }
      }
      return null;
    },
    [apps],
  );
  const openDiff = useCallback(
    (path: string, mode: "working" | "index") => {
      if (!appId) return;
      const owner = ownerOf(path);
      focusAppsDiffTab(owner?.app.id ?? appId, path, mode, owner?.app.slug);
    },
    [appId, ownerOf],
  );
  const openFile = useCallback(
    (path: string) => {
      const owner = ownerOf(path);
      if (owner) focusAppsFileTab(owner.app.id, owner.rel, owner.app.slug);
    },
    [ownerOf],
  );

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

  const [changesOpen, setChangesOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchAnchor, setBranchAnchor] = useState<null | HTMLElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

  const refresh = useCallback(() => {
    if (!workspaceId || !appId) return;
    void fetchStatus(workspaceId, appId);
    void fetchHistory(workspaceId, appId, "repo");
  }, [workspaceId, appId, fetchStatus, fetchHistory]);

  useEffect(refresh, [refresh]);

  // History follows the current branch, but the mount-time fetch races the
  // status call (branch unknown -> default branch). Refetch once it lands.
  const currentBranch = status?.branch;
  useEffect(() => {
    if (workspaceId && appId && currentBranch) {
      void fetchHistory(workspaceId, appId, "repo");
    }
  }, [workspaceId, appId, currentBranch, fetchHistory]);

  const handleCommit = useCallback(async () => {
    if (!workspaceId || !appId || !message.trim() || committing) return;
    setCommitting(true);
    setError(null);
    const result = await commit(workspaceId, appId, message.trim(), {
      stagedOnly: staged.length > 0,
    });
    setCommitting(false);
    if (result.ok) setMessage("");
    else setError(result.error ?? "Commit failed");
  }, [workspaceId, appId, message, committing, commit, staged.length]);

  const branch = status?.branch ?? "…";
  const branches = useAppsStore(s =>
    appId ? s.branchesByApp[appId] : undefined,
  );
  const fetchBranches = useAppsStore(s => s.fetchBranches);
  const checkoutBranch = useAppsStore(s => s.checkoutBranch);
  const mergeBranch = useAppsStore(s => s.mergeBranch);
  const [merging, setMerging] = useState(false);
  // The current branch's entry in the listing — what "Merge into main" acts
  // on. Only offered for a non-default branch that is actually ahead.
  const currentEntry = branches?.find(b => b.name === branch);
  const canMerge =
    !!currentEntry && !currentEntry.isDefault && currentEntry.aheadOfMain > 0;
  const mergeCurrent = useCallback(async () => {
    if (!workspaceId || !appId || !currentEntry || merging) return;
    setMerging(true);
    setError(null);
    const result = await mergeBranch(workspaceId, appId, currentEntry.name);
    setMerging(false);
    setBranchAnchor(null);
    if (!result.ok) setError(result.error ?? "Merge failed");
    else {
      void fetchStatus(workspaceId, appId);
      void fetchHistory(workspaceId, appId, "repo");
    }
  }, [
    workspaceId,
    appId,
    currentEntry,
    merging,
    mergeBranch,
    fetchStatus,
    fetchHistory,
  ]);

  const switchTo = useCallback(
    async (target: string, options?: { create?: boolean }) => {
      if (!workspaceId || !appId || switching) return;
      setSwitching(true);
      setError(null);
      const failure = await checkoutBranch(workspaceId, appId, target, options);
      setSwitching(false);
      setBranchAnchor(null);
      setCreateOpen(false);
      if (failure) setError(failure);
      else {
        setNewBranchName("");
        void fetchHistory(workspaceId, appId, "repo");
      }
    },
    [workspaceId, appId, switching, checkoutBranch, fetchHistory],
  );

  const commits = useMemo(() => history ?? [], [history]);

  if (!workspaceId) return null;

  return (
    <VSScrollArea style={{ height: "100%" }}>
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        {/* Panel title, VS Code style. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 1.5,
            pt: 1,
            pb: 0.5,
          }}
        >
          <Typography
            variant="caption"
            sx={{ fontWeight: 700, letterSpacing: 0.4, fontSize: "0.72rem" }}
          >
            SOURCE CONTROL
          </Typography>
          <Box sx={{ flex: 1 }} />
          {appId && (
            <Tooltip title="Switch branch — the same `git checkout` the terminal runs">
              <Button
                size="small"
                onClick={e => {
                  setBranchAnchor(e.currentTarget);
                  if (workspaceId) void fetchBranches(workspaceId, appId);
                }}
                startIcon={
                  switching ? (
                    <CircularProgress size={12} />
                  ) : (
                    <BranchIcon size={13} strokeWidth={1.75} />
                  )
                }
                sx={{
                  textTransform: "none",
                  fontSize: "0.72rem",
                  color: "text.secondary",
                  minWidth: 0,
                  maxWidth: 180,
                  "& .MuiButton-startIcon": { mr: 0.5 },
                }}
              >
                <Box
                  component="span"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {branch}
                </Box>
              </Button>
            </Tooltip>
          )}
          {(status?.ahead ?? 0) > 0 && (
            <Tooltip
              title={`${status?.ahead} commit${status?.ahead === 1 ? "" : "s"} not yet pushed — pushed automatically`}
            >
              <Chip
                size="small"
                label={`↑${status?.ahead}`}
                sx={{ height: 16, fontSize: "0.62rem", mr: 0.5 }}
              />
            </Tooltip>
          )}
          <Tooltip title="GitHub — link or manage the repository">
            <IconButton size="small" onClick={openGitHubSettings}>
              <GitHubIcon size={14} strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={refresh}>
              <RefreshIcon size={14} strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
        </Box>

        <Menu
          anchorEl={branchAnchor}
          open={!!branchAnchor}
          onClose={() => setBranchAnchor(null)}
        >
          {(branches ?? []).map(b => (
            <MenuItem
              key={b.name}
              dense
              disabled={switching}
              onClick={() => void switchTo(b.name)}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                {b.name === branch ? (
                  <CheckIcon size={14} />
                ) : (
                  <BranchIcon size={14} strokeWidth={1.5} />
                )}
              </ListItemIcon>
              <ListItemText
                primary={b.name}
                primaryTypographyProps={{ fontSize: 13 }}
              />
            </MenuItem>
          ))}
          <Divider />
          {canMerge && (
            <MenuItem
              dense
              disabled={switching || merging}
              onClick={() => void mergeCurrent()}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                {merging ? (
                  <CircularProgress size={14} />
                ) : (
                  <MergeIcon size={14} strokeWidth={1.75} />
                )}
              </ListItemIcon>
              <ListItemText
                primary={`Merge "${branch}" into main`}
                secondary={`${currentEntry?.aheadOfMain} commit${currentEntry?.aheadOfMain === 1 ? "" : "s"} ahead`}
                primaryTypographyProps={{ fontSize: 13 }}
                secondaryTypographyProps={{ fontSize: 11 }}
              />
            </MenuItem>
          )}
          <MenuItem
            dense
            disabled={switching}
            onClick={() => {
              setBranchAnchor(null);
              setCreateOpen(true);
            }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}>
              <PlusIcon size={14} strokeWidth={1.75} />
            </ListItemIcon>
            <ListItemText
              primary="Create new branch…"
              primaryTypographyProps={{ fontSize: 13 }}
            />
          </MenuItem>
        </Menu>

        <Dialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          maxWidth="xs"
          fullWidth
        >
          <DialogTitle sx={{ fontSize: 15 }}>Create branch</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              size="small"
              placeholder={`New branch from "${branch}"`}
              value={newBranchName}
              onChange={e => setNewBranchName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newBranchName.trim()) {
                  void switchTo(newBranchName.trim(), { create: true });
                }
              }}
              sx={{ mt: 0.5 }}
            />
          </DialogContent>
          <DialogActions>
            <Button size="small" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={!newBranchName.trim() || switching}
              onClick={() =>
                void switchTo(newBranchName.trim(), { create: true })
              }
            >
              {switching ? "Creating…" : "Create & switch"}
            </Button>
          </DialogActions>
        </Dialog>

        <Dialog open={!!confirm} onClose={() => !acting && setConfirm(null)}>
          <DialogTitle sx={{ fontSize: 15 }}>{confirm?.title}</DialogTitle>
          <DialogContent>
            <Typography variant="body2">{confirm?.body}</Typography>
          </DialogContent>
          <DialogActions>
            <Button
              size="small"
              onClick={() => setConfirm(null)}
              disabled={acting}
            >
              Cancel
            </Button>
            <Button
              size="small"
              color="error"
              variant="contained"
              disabled={acting}
              onClick={async () => {
                const paths = confirm?.paths ?? [];
                await runGit("discard", paths);
                setConfirm(null);
              }}
            >
              {acting ? "Discarding…" : "Discard"}
            </Button>
          </DialogActions>
        </Dialog>

        {error && (
          <Alert
            severity="error"
            onClose={() => setError(null)}
            sx={{
              mx: 1.5,
              mb: 1,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              "& .MuiAlert-message": { maxHeight: 200, overflowY: "auto" },
            }}
          >
            {error}
          </Alert>
        )}

        {!appId ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            The workspace repository appears with its first app — create one in
            Apps and this panel takes over from there.
          </Typography>
        ) : (
          <>
            <Box sx={{ px: 1.5, pt: 1, pb: 1 }}>
              <TextField
                fullWidth
                size="small"
                multiline
                maxRows={4}
                placeholder={`Message (⌘⏎ to commit on "${branch}")`}
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    void handleCommit();
                  }
                }}
                disabled={committing}
                sx={{ mb: 1, "& .MuiInputBase-input": { fontSize: 13 } }}
              />
              <Tooltip
                title={
                  staged.length > 0
                    ? "Commits the staged changes only"
                    : "Nothing is staged: commits all changes (VS Code's smart commit)"
                }
              >
                <span>
                  <Button
                    fullWidth
                    variant="contained"
                    size="small"
                    disabled={
                      committing || !message.trim() || changes.length === 0
                    }
                    onClick={() => void handleCommit()}
                    startIcon={
                      committing ? <CircularProgress size={14} /> : undefined
                    }
                  >
                    {committing
                      ? "Committing…"
                      : staged.length > 0
                        ? `✓ Commit ${staged.length} staged`
                        : "✓ Commit all"}
                  </Button>
                </span>
              </Tooltip>
            </Box>

            {staged.length > 0 && (
              <Section
                label="Staged Changes"
                open={changesOpen}
                onToggle={() => setChangesOpen(o => !o)}
                actions={
                  <>
                    <RowAction
                      title="Unstage all changes"
                      onClick={() =>
                        void runGit(
                          "unstage",
                          staged.map(c => c.path),
                        )
                      }
                    >
                      <MinusIcon size={14} />
                    </RowAction>
                    <Chip
                      label={staged.length}
                      size="small"
                      sx={{ height: 16, fontSize: "0.62rem" }}
                    />
                  </>
                }
              >
                <Box sx={{ pb: 1 }}>
                  {staged.map(change => (
                    <ChangeRow
                      key={`staged:${change.path}`}
                      change={change}
                      onOpen={() => openDiff(change.path, "index")}
                      actions={
                        <>
                          {ownerOf(change.path) && (
                            <RowAction
                              title="Open file"
                              onClick={() => openFile(change.path)}
                            >
                              <OpenFileIcon size={13} />
                            </RowAction>
                          )}
                          <RowAction
                            title="Unstage changes"
                            onClick={() =>
                              void runGit("unstage", [change.path])
                            }
                          >
                            <MinusIcon size={14} />
                          </RowAction>
                        </>
                      }
                    />
                  ))}
                </Box>
              </Section>
            )}

            <Section
              label="Changes"
              open={changesOpen}
              onToggle={() => setChangesOpen(o => !o)}
              actions={
                unstaged.length > 0 ? (
                  <>
                    <RowAction
                      title="Discard all changes"
                      onClick={() =>
                        setConfirm({
                          title: "Discard all changes?",
                          body: `This restores ${unstaged.length} file${unstaged.length === 1 ? "" : "s"} to the last staged/committed version and deletes untracked files. This cannot be undone.`,
                          paths: unstaged.map(c => c.path),
                        })
                      }
                    >
                      <DiscardIcon size={13} />
                    </RowAction>
                    <RowAction
                      title="Stage all changes"
                      onClick={() =>
                        void runGit(
                          "stage",
                          unstaged.map(c => c.path),
                        )
                      }
                    >
                      <PlusIcon size={14} />
                    </RowAction>
                    <Chip
                      label={unstaged.length}
                      size="small"
                      sx={{ height: 16, fontSize: "0.62rem" }}
                    />
                  </>
                ) : undefined
              }
            >
              {unstaged.length === 0 ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ px: 2, pb: 1, display: "block" }}
                >
                  {staged.length > 0 ? "Everything is staged." : "No changes."}
                </Typography>
              ) : (
                <Box sx={{ pb: 1 }}>
                  {unstaged.map(change => (
                    <ChangeRow
                      key={`unstaged:${change.path}`}
                      change={change}
                      onOpen={() => openDiff(change.path, "working")}
                      actions={
                        <>
                          {ownerOf(change.path) && (
                            <RowAction
                              title="Open file"
                              onClick={() => openFile(change.path)}
                            >
                              <OpenFileIcon size={13} />
                            </RowAction>
                          )}
                          <RowAction
                            title="Discard changes"
                            onClick={() =>
                              setConfirm({
                                title: `Discard changes to ${change.path.split("/").pop()}?`,
                                body:
                                  change.status === "added"
                                    ? "This deletes the file. It cannot be undone."
                                    : "This restores the last staged/committed version. It cannot be undone.",
                                paths: [change.path],
                              })
                            }
                          >
                            <DiscardIcon size={13} />
                          </RowAction>
                          <RowAction
                            title="Stage changes"
                            onClick={() => void runGit("stage", [change.path])}
                          >
                            <PlusIcon size={14} />
                          </RowAction>
                        </>
                      }
                    />
                  ))}
                </Box>
              )}
            </Section>

            <Divider />

            <Section
              label="Graph"
              open={graphOpen}
              onToggle={() => setGraphOpen(o => !o)}
            >
              <Box sx={{ pb: 1 }}>
                {commits.length === 0 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ px: 2, display: "block" }}
                  >
                    No commits yet.
                  </Typography>
                )}
                {commits.map((entry, index) => (
                  <Box
                    key={entry.oid}
                    title={`${entry.oid.slice(0, 8)} — ${entry.author}`}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      px: 1.5,
                      py: 0.4,
                      minWidth: 0,
                      overflow: "hidden",
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    {/* The rail dot; VS Code rings the newest commit. */}
                    <Box
                      sx={{
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        flexShrink: 0,
                        bgcolor: index === 0 ? "transparent" : "primary.main",
                        border: index === 0 ? 2 : 0,
                        borderColor: "primary.main",
                      }}
                    />
                    {/* Subject owns the row; the author yields. VS Code does
                      the same — with both fighting for the same pixels the
                      subject collapsed to two letters in a narrow rail while
                      an email address took the line. */}
                    <Box
                      component="span"
                      sx={{
                        flex: 1,
                        minWidth: 40,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                      }}
                    >
                      {entry.subject}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        color: "text.disabled",
                        fontSize: 11.5,
                        flexShrink: 1,
                        minWidth: 0,
                        maxWidth: "35%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.author}
                    </Box>
                    {index === 0 && (
                      <Chip
                        icon={<BranchIcon size={11} />}
                        label={branch}
                        size="small"
                        color="primary"
                        sx={{
                          ml: "auto",
                          height: 18,
                          fontSize: "0.66rem",
                          flexShrink: 0,
                        }}
                      />
                    )}
                  </Box>
                ))}
              </Box>
            </Section>
          </>
        )}
      </Box>
    </VSScrollArea>
  );
}
