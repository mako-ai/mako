/**
 * A console's commit history, from the console toolbar — the apps History
 * popover for a console (apps.md §16): the same rows, the same actions.
 *
 * Every commit can be inspected (its file, opening the real diff for that
 * commit) and restored (a NEW commit that sets the console back to that
 * content — history is append-only, so nothing is lost). Saved consoles are
 * files in the workspace repo, so edits pushed from a clone or a terminal
 * appear here alongside saves made in the app.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Typography,
} from "@mui/material";
import {
  Copy as CopyIcon,
  FileDiff as DiffIcon,
  Undo2 as RestoreIcon,
} from "lucide-react";
import type { AppCommit } from "../store/appsStore";
import { useConsoleHistoryStore } from "../store/consoleHistoryStore";
import { useConsoleStore } from "../store/consoleStore";
import { CommitChip, CommitRow } from "./CommitRow";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Open (or focus) the diff tab for one file of one commit. */
function focusConsoleDiffTab(consoleId: string, path: string, sha: string) {
  return useConsoleStore.getState().focusOrOpenTab(
    {
      kind: "console-diff",
      metadata: { consoleId, path, sha },
    },
    () => ({
      title: `${basename(path)} (${sha.slice(0, 7)})`,
      content: "",
      kind: "console-diff",
      metadata: { consoleId, path, sha },
    }),
  );
}

export default function ConsoleHistoryPopover({
  anchorEl,
  onClose,
  workspaceId,
  consoleId,
  onRestored,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  workspaceId: string;
  consoleId: string;
  /** The console's content changed on the server: reload the open tab. */
  onRestored?: () => void;
}) {
  const history = useConsoleHistoryStore(s => s.historyByConsole[consoleId]);
  const repoPath = useConsoleHistoryStore(s => s.pathByConsole[consoleId]);
  const commitFiles = useConsoleHistoryStore(
    s => s.commitFilesByConsole[consoleId],
  );
  const fetchHistory = useConsoleHistoryStore(s => s.fetchHistory);
  const fetchCommitFiles = useConsoleHistoryStore(s => s.fetchCommitFiles);
  const restoreVersion = useConsoleHistoryStore(s => s.restoreVersion);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    commit: AppCommit;
  } | null>(null);
  const [confirm, setConfirm] = useState<AppCommit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = Boolean(anchorEl);
  useEffect(() => {
    if (open) void fetchHistory(workspaceId, consoleId);
    else {
      setExpanded(null);
      setMenu(null);
      setError(null);
    }
  }, [open, workspaceId, consoleId, fetchHistory]);

  const toggleFiles = useCallback(
    (oid: string) => {
      const next = expanded === oid ? null : oid;
      setExpanded(next);
      if (next) void fetchCommitFiles(workspaceId, consoleId, next);
    },
    [expanded, fetchCommitFiles, workspaceId, consoleId],
  );

  const runConfirmed = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await restoreVersion(workspaceId, consoleId, confirm.oid);
      setNotice(`Restored "${confirm.subject}" as a new commit on main.`);
      setConfirm(null);
      onRestored?.();
    } catch (e) {
      setError(errorMessage(e, "Could not restore this version"));
    } finally {
      setBusy(false);
    }
  }, [confirm, restoreVersion, workspaceId, consoleId, onRestored]);

  const commits = history ?? [];
  const headOid = commits[0]?.oid;

  return (
    <>
      <Popover
        anchorEl={anchorEl}
        open={open}
        onClose={onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width: 560,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "60vh",
              display: "flex",
              flexDirection: "column",
            },
          },
        }}
      >
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            gap: 1,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <Typography variant="subtitle2">History</Typography>
          <Chip size="small" label="main" sx={{ height: 20 }} />
          {repoPath && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              sx={{ fontFamily: "monospace", minWidth: 0 }}
              title={repoPath}
            >
              {repoPath}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {history === undefined && <CircularProgress size={14} />}
        </Box>
        {(error || notice) && (
          <Alert
            severity={error ? "error" : "success"}
            onClose={() => {
              setError(null);
              setNotice(null);
            }}
            sx={{ borderRadius: 0, flexShrink: 0 }}
          >
            {error ?? notice}
          </Alert>
        )}
        <Box sx={{ overflowY: "auto", minHeight: 0 }}>
          {history !== undefined && commits.length === 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 2, py: 2 }}
            >
              {repoPath
                ? "No commits yet."
                : "This console is not in the workspace repo yet — save it once to start its history."}
            </Typography>
          )}
          {commits.map(c => (
            <CommitRow
              key={c.oid}
              commit={c}
              expanded={expanded === c.oid}
              onToggle={() => toggleFiles(c.oid)}
              files={commitFiles?.[c.oid]}
              onFileClick={f => {
                focusConsoleDiffTab(consoleId, f.path, c.oid);
                onClose();
              }}
              onMenu={anchor => setMenu({ anchor, commit: c })}
              chips={
                c.oid === headOid ? (
                  <CommitChip label="Latest" outlined />
                ) : undefined
              }
            />
          ))}
        </Box>
      </Popover>

      <Menu
        anchorEl={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
      >
        <MenuItem
          onClick={() => {
            if (menu) toggleFiles(menu.commit.oid);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <DiffIcon size={16} />
          </ListItemIcon>
          <ListItemText>View changes</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!!menu && menu.commit.oid === headOid}
          onClick={() => {
            if (menu) setConfirm(menu.commit);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <RestoreIcon size={16} />
          </ListItemIcon>
          <ListItemText
            primary="Restore this version…"
            secondary="New commit on main; nothing is lost"
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) void navigator.clipboard?.writeText(menu.commit.oid);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <CopyIcon size={16} />
          </ListItemIcon>
          <ListItemText>Copy commit SHA</ListItemText>
        </MenuItem>
      </Menu>

      <Dialog open={Boolean(confirm)} onClose={() => !busy && setConfirm(null)}>
        <DialogTitle>Restore this version?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm && (
              <>
                The console goes back to what it was in <b>{confirm.subject}</b>{" "}
                (<code>{confirm.oid.slice(0, 7)}</code>
                ), as a new commit on <b>main</b>. Everything after it stays in
                the history, so this can itself be undone.
              </>
            )}
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void runConfirmed()}
            disabled={busy}
          >
            {busy ? "Working…" : "Restore"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
