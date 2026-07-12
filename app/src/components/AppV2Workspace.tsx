/**
 * Apps v2 workspace view — the content of an `app-v2` tab.
 *
 * IDE-style layout over the durable worktree API:
 *
 *   ┌ toolbar: status chip · Code/Preview toggle · Build & preview ·
 *   │          Commit · History · Discard
 *   ├ file tree │ Monaco editor (debounced save → WIP flush)   ← "code" mode
 *   │           │ token-gated sandboxed iframe                  ← "preview"
 *   └ terminal: run any shell command in the app's sandbox session
 *
 * Every read here comes from git (bare repo + WIP refs) through the store, so
 * the view renders identically whether the app's sandbox session is warm or
 * was rebuilt after eviction.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  InputBase,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme as useMuiTheme,
} from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Eraser as ClearIcon,
  FileCode as FileIcon,
  Folder as FolderIcon,
  GitCommitHorizontal as CommitIcon,
  History as HistoryIcon,
  Play as PlayIcon,
  RotateCcw as DiscardIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useAppsV2Store,
  type AppV2FileEntry,
  type AppV2TerminalEntry,
} from "../store/appsV2Store";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";

// ---------------------------------------------------------------------------
// File tree (flat entries -> nested folders)
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

function buildTree(entries: AppV2FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    const segments = entry.path.split("/");
    let level = root;
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      prefix = prefix ? `${prefix}/${name}` : name;
      const isLeaf = i === segments.length - 1;
      let node = level.find(n => n.name === name && !!n.children === !isLeaf);
      if (!node) {
        node = { name, path: prefix, ...(isLeaf ? {} : { children: [] }) };
        level.push(node);
      }
      if (!isLeaf) level = node.children as TreeNode[];
    }
  }
  const sortLevel = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = a.children ? 0 : 1;
      const bDir = b.children ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sortLevel(n.children);
    return nodes;
  };
  return sortLevel(root);
}

function FileTreeLevel({
  nodes,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map(node => {
        const isDir = Boolean(node.children);
        const isOpen = expanded.has(node.path);
        return (
          <Box key={node.path}>
            <ListItemButton
              dense
              selected={!isDir && selected === node.path}
              onClick={() =>
                isDir ? onToggle(node.path) : onSelect(node.path)
              }
              sx={{ pl: 1 + depth * 1.5, py: 0.25, minHeight: 26 }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  overflow: "hidden",
                }}
              >
                {isDir ? (
                  isOpen ? (
                    <ChevronDownIcon size={13} />
                  ) : (
                    <ChevronRightIcon size={13} />
                  )
                ) : null}
                {isDir ? <FolderIcon size={13} /> : <FileIcon size={13} />}
                <Typography variant="caption" noWrap>
                  {node.name}
                </Typography>
              </Box>
            </ListItemButton>
            {isDir && isOpen && node.children && (
              <FileTreeLevel
                nodes={node.children}
                depth={depth + 1}
                selected={selected}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </Box>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

function TerminalPanel({
  appId,
  workspaceId,
}: {
  appId: string;
  workspaceId: string;
}) {
  const entries = useAppsV2Store(s => s.terminalByApp[appId] ?? EMPTY_TERMINAL);
  const running = useAppsV2Store(s => Boolean(s.execRunning[appId]));
  const runCommand = useAppsV2Store(s => s.runCommand);
  const clearTerminal = useAppsV2Store(s => s.clearTerminal);
  const [command, setCommand] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const submit = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || running) return;
    setCommand("");
    void runCommand(workspaceId, appId, trimmed);
  }, [command, running, runCommand, workspaceId, appId]);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        fontFamily: "monospace",
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.25,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <TerminalIcon size={14} />
        <Typography variant="caption" sx={{ flex: 1 }}>
          {"Terminal — runs in the app's sandbox session (repo root)"}
        </Typography>
        <Tooltip title="Clear">
          <IconButton size="small" onClick={() => clearTerminal(appId)}>
            <ClearIcon size={14} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box ref={scrollRef} sx={{ flex: 1, overflow: "auto", px: 1, py: 0.5 }}>
        {entries.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            Try: ls · git status · git log --oneline · npm install · npm run
            build
          </Typography>
        )}
        {entries.map(entry => (
          <TerminalEntryView key={entry.id} entry={entry} />
        ))}
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="caption"
          color="success.main"
          sx={{ fontFamily: "monospace" }}
        >
          $
        </Typography>
        <InputBase
          fullWidth
          placeholder={
            running ? "Running..." : "Type a command and press Enter"
          }
          value={command}
          disabled={running}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          sx={{ fontFamily: "monospace", fontSize: 13 }}
          inputProps={{ "aria-label": "terminal command" }}
        />
        {running && <CircularProgress size={14} />}
      </Box>
    </Box>
  );
}

const EMPTY_TERMINAL: AppV2TerminalEntry[] = [];

function TerminalEntryView({ entry }: { entry: AppV2TerminalEntry }) {
  return (
    <Box sx={{ mb: 0.75 }}>
      <Typography
        variant="caption"
        sx={{ fontFamily: "monospace", fontWeight: 600 }}
      >
        $ {entry.command}
      </Typography>
      {entry.running ? (
        <Typography variant="caption" display="block" color="text.secondary">
          running...
        </Typography>
      ) : (
        <>
          {entry.stdout && (
            <Typography
              variant="caption"
              component="pre"
              sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}
            >
              {entry.stdout}
            </Typography>
          )}
          {entry.stderr && (
            <Typography
              variant="caption"
              component="pre"
              color="warning.main"
              sx={{ m: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" }}
            >
              {entry.stderr}
            </Typography>
          )}
          {entry.exitCode !== 0 && (
            <Typography variant="caption" color="error.main" display="block">
              exit {entry.exitCode}
              {entry.timedOut ? " (timed out)" : ""}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function AppV2Workspace({
  tabId: _tabId,
  appId,
}: {
  tabId: string;
  appId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useMuiTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const app = useAppsV2Store(s => s.apps.find(a => a.id === appId));
  const files = useAppsV2Store(s => s.filesByApp[appId]);
  const selectedFile = useAppsV2Store(s => s.selectedFile[appId] ?? null);
  const fileEntry = useAppsV2Store(s =>
    selectedFile ? s.fileContents[`${appId}\u0000${selectedFile}`] : undefined,
  );
  const status = useAppsV2Store(s => s.statusByApp[appId]);
  const history = useAppsV2Store(s => s.historyByApp[appId]);
  const preview = useAppsV2Store(s => s.previewByApp[appId]);
  const viewMode = useAppsV2Store(s => s.viewMode[appId] ?? "code");

  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const fetchFiles = useAppsV2Store(s => s.fetchFiles);
  const fetchStatus = useAppsV2Store(s => s.fetchStatus);
  const fetchHistory = useAppsV2Store(s => s.fetchHistory);
  const openFile = useAppsV2Store(s => s.openFile);
  const updateFileLocal = useAppsV2Store(s => s.updateFileLocal);
  const saveFile = useAppsV2Store(s => s.saveFile);
  const commit = useAppsV2Store(s => s.commit);
  const discard = useAppsV2Store(s => s.discard);
  const buildPreview = useAppsV2Store(s => s.buildPreview);
  const setViewMode = useAppsV2Store(s => s.setViewMode);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [historyAnchor, setHistoryAnchor] = useState<null | HTMLElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    if (!app) void fetchApps(workspaceId);
    void fetchFiles(workspaceId, appId);
    void fetchStatus(workspaceId, appId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId]);

  // Auto-open the entrypoint on first load.
  useEffect(() => {
    if (!workspaceId || selectedFile || !files?.length) return;
    const preferred =
      files.find(f => f.path === "src/App.tsx") ??
      files.find(f => f.path.endsWith(".tsx")) ??
      files[0];
    if (preferred) void openFile(workspaceId, appId, preferred.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId, files, selectedFile]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const changeCount = status?.changes.length ?? 0;

  const handleToggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (workspaceId) void openFile(workspaceId, appId, path);
      setViewMode(appId, "code");
    },
    [workspaceId, appId, openFile, setViewMode],
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!selectedFile) return;
      updateFileLocal(appId, selectedFile, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        const path = selectedFile;
        saveTimer.current = setTimeout(() => {
          void saveFile(workspaceId, appId, path);
        }, 1000);
      }
    },
    [appId, selectedFile, workspaceId, updateFileLocal, saveFile],
  );

  const handleCommit = useCallback(async () => {
    if (!workspaceId || !commitMessage.trim()) return;
    setCommitting(true);
    setCommitError(null);
    const result = await commit(workspaceId, appId, commitMessage.trim());
    setCommitting(false);
    if (result.ok) {
      setCommitOpen(false);
      setCommitMessage("");
    } else {
      setCommitError(result.error ?? "Commit failed");
    }
  }, [workspaceId, appId, commitMessage, commit]);

  const handleDiscard = useCallback(() => {
    if (!workspaceId) return;
    if (!window.confirm("Discard ALL uncommitted changes in this app?")) return;
    void discard(workspaceId, appId);
  }, [workspaceId, appId, discard]);

  if (!workspaceId) return null;

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ maxWidth: 240 }}>
          {app?.title ?? "App"}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={changeCount > 0 ? "warning" : "default"}
          label={
            changeCount > 0
              ? `${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`
              : "clean"
          }
        />
        {status?.behindBranch && (
          <Chip size="small" color="error" label="behind main" />
        )}
        <Box sx={{ flex: 1 }} />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={viewMode}
          onChange={(_, v) => v && setViewMode(appId, v)}
        >
          <ToggleButton value="code">Code</ToggleButton>
          <ToggleButton value="preview" disabled={!preview?.url}>
            Preview
          </ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title="npm install (if needed) + npm run build in the sandbox, then preview the built app">
          <span>
            <Button
              size="small"
              variant="contained"
              startIcon={
                preview?.building ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <PlayIcon size={14} />
                )
              }
              disabled={preview?.building}
              onClick={() => void buildPreview(workspaceId, appId)}
            >
              {preview?.building ? "Building..." : "Build & preview"}
            </Button>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="outlined"
          startIcon={<CommitIcon size={14} />}
          disabled={changeCount === 0}
          onClick={() => setCommitOpen(true)}
        >
          Commit
        </Button>
        <Tooltip title="History">
          <IconButton
            size="small"
            onClick={e => {
              setHistoryAnchor(e.currentTarget);
              void fetchHistory(workspaceId, appId);
            }}
          >
            <HistoryIcon size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Discard all uncommitted changes">
          <span>
            <IconButton
              size="small"
              disabled={changeCount === 0}
              onClick={handleDiscard}
            >
              <DiscardIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {preview?.error && viewMode === "code" && (
        <Alert
          severity="error"
          onClose={() =>
            useAppsV2Store.setState(s => {
              const p = s.previewByApp[appId];
              if (p) p.error = null;
            })
          }
          sx={{
            borderRadius: 0,
            whiteSpace: "pre-wrap",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {preview.error}
        </Alert>
      )}

      {/* Body */}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        {viewMode === "preview" && preview?.url ? (
          <iframe
            title="App preview"
            src={preview.url}
            sandbox="allow-scripts allow-forms"
            style={{ border: 0, width: "100%", height: "100%" }}
          />
        ) : (
          <>
            <Box
              sx={{
                width: 220,
                flexShrink: 0,
                borderRight: "1px solid",
                borderColor: "divider",
                overflow: "auto",
              }}
            >
              <List dense disablePadding>
                <FileTreeLevel
                  nodes={tree}
                  depth={0}
                  selected={selectedFile}
                  expanded={expanded}
                  onToggle={handleToggle}
                  onSelect={handleSelect}
                />
              </List>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {selectedFile && fileEntry ? (
                <MonacoEditor
                  height="100%"
                  path={`apps-v2/${appId}/${selectedFile}`}
                  language={languageForPath(selectedFile)}
                  value={fileEntry.contents}
                  theme={monacoTheme}
                  beforeMount={configureMonacoForJsx}
                  onChange={handleEditorChange}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                  }}
                />
              ) : (
                <Box sx={{ p: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Select a file to edit.
                  </Typography>
                </Box>
              )}
            </Box>
          </>
        )}
      </Box>

      <Divider />

      {/* Terminal */}
      <Box sx={{ height: 200, flexShrink: 0 }}>
        <TerminalPanel appId={appId} workspaceId={workspaceId} />
      </Box>

      {/* History menu */}
      <Menu
        anchorEl={historyAnchor}
        open={Boolean(historyAnchor)}
        onClose={() => setHistoryAnchor(null)}
      >
        {(history ?? []).length === 0 && (
          <MenuItem disabled>No commits yet</MenuItem>
        )}
        {(history ?? []).map(c => (
          <MenuItem key={c.oid} disabled sx={{ opacity: 1 }}>
            <ListItemText
              primary={c.subject}
              secondary={`${c.oid.slice(0, 8)} · ${c.author} · ${new Date(c.timestamp).toLocaleString()}`}
            />
          </MenuItem>
        ))}
      </Menu>

      {/* Commit dialog */}
      <Dialog
        open={commitOpen}
        onClose={() => !committing && setCommitOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Commit changes</DialogTitle>
        <DialogContent>
          {status && status.changes.length > 0 && (
            <Box sx={{ mb: 1 }}>
              {status.changes.map(ch => (
                <Typography
                  key={ch.path}
                  variant="caption"
                  display="block"
                  sx={{ fontFamily: "monospace" }}
                >
                  {ch.status[0].toUpperCase()} {ch.path}
                </Typography>
              ))}
            </Box>
          )}
          <TextField
            autoFocus
            fullWidth
            label="Commit message"
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            disabled={committing}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleCommit();
              }
            }}
          />
          {commitError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {commitError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCommitOpen(false)} disabled={committing}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCommit()}
            disabled={committing || !commitMessage.trim()}
          >
            {committing ? "Committing..." : "Commit"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
