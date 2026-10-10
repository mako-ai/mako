/**
 * An entity's commit history — consoles, notebooks, flows, workspace
 * connectors — the apps History popover (apps.md §16): the same rows, the
 * same actions, for anything whose definition is files in the workspace repo.
 *
 * Every commit can be inspected (its files, each opening the real diff for
 * that commit) and restored (a NEW commit that sets the entity back to that
 * content — history is append-only, so nothing is lost). Edits pushed from a
 * clone, a terminal or an agent appear here alongside saves made in the app.
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
import {
  historyKey,
  useEntityHistoryStore,
  type HistoryEntityKind,
} from "../store/entityHistoryStore";
import { useConsoleStore } from "../store/consoleStore";
import { CommitChip, CommitRow } from "./CommitRow";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Open (or focus) the diff tab for one file of one commit. */
function focusHistoryDiffTab(
  entity: HistoryEntityKind,
  id: string,
  path: string,
  sha: string,
) {
  return useConsoleStore.getState().focusOrOpenTab(
    {
      kind: "history-diff",
      metadata: { entity, id, path, sha },
    },
    () => ({
      title: `${basename(path)} (${sha.slice(0, 7)})`,
      content: "",
      kind: "history-diff",
      metadata: { entity, id, path, sha },
    }),
  );
}

export default function EntityHistoryPopover({
  anchorEl,
  onClose,
  workspaceId,
  entity,
  id,
  onRestored,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  workspaceId: string;
  entity: HistoryEntityKind;
  /** Console/notebook/flow id, or the connector's folder slug. */
  id: string;
  /** The entity changed on the server: reload whatever shows it. */
  onRestored?: () => void;
}) {
  const key = historyKey(entity, id);
  const history = useEntityHistoryStore(s => s.history[key]);
  const repoPath = useEntityHistoryStore(s => s.path[key]);
  const commitFiles = useEntityHistoryStore(s => s.commitFiles[key]);
  const fetchHistory = useEntityHistoryStore(s => s.fetchHistory);
  const fetchCommitFiles = useEntityHistoryStore(s => s.fetchCommitFiles);
  const restoreVersion = useEntityHistoryStore(s => s.restoreVersion);

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
    if (open) void fetchHistory(entity, workspaceId, id);
    else {
      setExpanded(null);
      setMenu(null);
      setError(null);
    }
  }, [open, entity, workspaceId, id, fetchHistory]);

  const toggleFiles = useCallback(
    (oid: string) => {
      const next = expanded === oid ? null : oid;
      setExpanded(next);
      if (next) void fetchCommitFiles(entity, workspaceId, id, next);
    },
    [expanded, fetchCommitFiles, entity, workspaceId, id],
  );

  const runConfirmed = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await restoreVersion(entity, workspaceId, id, confirm.oid);
      setNotice(`Restored "${confirm.subject}" as a new commit on main.`);
      setConfirm(null);
      onRestored?.();
    } catch (e) {
      setError(errorMessage(e, "Could not restore this version"));
    } finally {
      setBusy(false);
    }
  }, [confirm, restoreVersion, entity, workspaceId, id, onRestored]);

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
                : `This ${entity} is not in the workspace repo yet — save it once to start its history.`}
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
                focusHistoryDiffTab(entity, id, f.path, c.oid);
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
                The {entity} goes back to what it was in{" "}
                <b>{confirm.subject}</b> (<code>{confirm.oid.slice(0, 7)}</code>
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
