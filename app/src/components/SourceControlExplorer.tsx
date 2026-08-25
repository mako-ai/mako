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
 * The apps-v2 API is addressed per app, but status/commit/history all operate
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
  Divider,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  GitBranch as BranchIcon,
  RefreshCw as RefreshIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsV2Store, type AppV2Change } from "../store/appsV2Store";

/** VS Code's status letters, in VS Code's colors. */
const STATUS_STYLE: Record<
  AppV2Change["status"],
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

/** One changed file, VS Code style: name bright, directory dimmed, letter. */
function ChangeRow({ change }: { change: AppV2Change }) {
  const slash = change.path.lastIndexOf("/");
  const name = slash === -1 ? change.path : change.path.slice(slash + 1);
  const dir = slash === -1 ? "" : change.path.slice(0, slash);
  const style = STATUS_STYLE[change.status];
  return (
    <Box
      title={`${change.status}: ${change.path}`}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        px: 2,
        py: 0.25,
        minWidth: 0,
        "&:hover": { bgcolor: "action.hover" },
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

  const apps = useAppsV2Store(s => s.apps);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const statusByApp = useAppsV2Store(s => s.statusByApp);
  const historyByApp = useAppsV2Store(s => s.historyByApp);
  const fetchStatus = useAppsV2Store(s => s.fetchStatus);
  const fetchHistory = useAppsV2Store(s => s.fetchHistory);
  const commit = useAppsV2Store(s => s.commit);

  // Any app id reaches the workspace repo; the first one is the handle.
  const appId = apps[0]?.id;
  const status = appId ? statusByApp[appId] : undefined;
  const history = appId ? historyByApp[appId] : undefined;
  const changes = status?.repoChanges ?? [];

  const [changesOpen, setChangesOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

  const refresh = useCallback(() => {
    if (!workspaceId || !appId) return;
    void fetchStatus(workspaceId, appId);
    void fetchHistory(workspaceId, appId);
  }, [workspaceId, appId, fetchStatus, fetchHistory]);

  useEffect(refresh, [refresh]);

  const handleCommit = useCallback(async () => {
    if (!workspaceId || !appId || !message.trim() || committing) return;
    setCommitting(true);
    setError(null);
    const result = await commit(workspaceId, appId, message.trim());
    setCommitting(false);
    if (result.ok) setMessage("");
    else setError(result.error ?? "Commit failed");
  }, [workspaceId, appId, message, committing, commit]);

  const branch = status?.branch ?? "…";

  const commits = useMemo(() => history ?? [], [history]);

  if (!workspaceId) return null;

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Panel title, VS Code style. */}
      <Box
        sx={{ display: "flex", alignItems: "center", px: 1.5, pt: 1, pb: 0.5 }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, letterSpacing: 0.4, fontSize: "0.72rem" }}
        >
          SOURCE CONTROL
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={refresh}>
            <RefreshIcon size={14} strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      </Box>

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
          Apps v2 and this panel takes over from there.
        </Typography>
      ) : (
        <>
          <Section
            label="Changes"
            open={changesOpen}
            onToggle={() => setChangesOpen(o => !o)}
            actions={
              changes.length > 0 ? (
                <Chip
                  label={changes.length}
                  size="small"
                  sx={{ height: 16, fontSize: "0.62rem" }}
                />
              ) : undefined
            }
          >
            <Box sx={{ px: 1.5, pb: 1 }}>
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
              <Button
                fullWidth
                variant="contained"
                size="small"
                disabled={committing || !message.trim() || changes.length === 0}
                onClick={() => void handleCommit()}
                startIcon={
                  committing ? <CircularProgress size={14} /> : undefined
                }
              >
                {committing ? "Committing…" : "✓ Commit"}
              </Button>
            </Box>
            {changes.length === 0 ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ px: 2, pb: 1, display: "block" }}
              >
                No changes.
              </Typography>
            ) : (
              <Box sx={{ pb: 1 }}>
                {changes.map(change => (
                  <ChangeRow key={change.path} change={change} />
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
                      label="main"
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
  );
}
