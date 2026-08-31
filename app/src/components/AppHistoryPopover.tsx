/**
 * The app's commit history, from the workbench toolbar — readable and
 * actionable, not a disabled menu.
 *
 * Every commit can be inspected (its changed files, each opening the real
 * diff for that commit), restored (a NEW commit that sets the app back to
 * that content — history is append-only, so nothing is lost) and, when a
 * build for it is still stored, made the live version again (a repoint, no
 * rebuild). The popover is capped: it scrolls instead of taking the screen.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown as ExpandIcon,
  ChevronRight as CollapsedIcon,
  Copy as CopyIcon,
  FileDiff as DiffIcon,
  MoreHorizontal as MoreIcon,
  Rocket as LiveIcon,
  Undo2 as RestoreIcon,
} from "lucide-react";
import { useAppsStore, type AppCommit } from "../store/appsStore";
import { focusAppsDiffTab } from "../apps-runtime/shell";

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function AppHistoryPopover({
  anchorEl,
  onClose,
  workspaceId,
  appId,
  slug,
  branch,
  publishedSha,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  workspaceId: string;
  appId: string;
  slug?: string;
  branch: string;
  publishedSha?: string;
}) {
  const history = useAppsStore(s => s.historyByApp[appId]);
  const commitFiles = useAppsStore(s => s.commitFilesByApp[appId]);
  const fetchCommitFiles = useAppsStore(s => s.fetchCommitFiles);
  const restoreVersion = useAppsStore(s => s.restoreVersion);
  const rollbackTo = useAppsStore(s => s.rollbackTo);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    commit: AppCommit;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "rollback";
    commit: AppCommit;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = Boolean(anchorEl);
  useEffect(() => {
    if (!open) {
      setExpanded(null);
      setMenu(null);
      setError(null);
    }
  }, [open]);

  const toggleFiles = useCallback(
    (oid: string) => {
      const next = expanded === oid ? null : oid;
      setExpanded(next);
      if (next) void fetchCommitFiles(workspaceId, appId, next);
    },
    [expanded, fetchCommitFiles, workspaceId, appId],
  );

  const runConfirmed = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm.kind === "restore") {
        await restoreVersion(workspaceId, appId, confirm.commit.oid);
        setNotice(
          `Restored "${confirm.commit.subject}" as a new commit on ${branch}.`,
        );
      } else {
        await rollbackTo(workspaceId, appId, confirm.commit.oid);
        setNotice(`The live app now serves ${confirm.commit.oid.slice(0, 7)}.`);
      }
      setConfirm(null);
    } catch (e) {
      setError(
        errorMessage(
          e,
          confirm.kind === "restore"
            ? "Could not restore this version"
            : "Could not roll back the live app",
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [confirm, restoreVersion, rollbackTo, workspaceId, appId, branch]);

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
          }}
        >
          <Typography variant="subtitle2">History</Typography>
          <Chip size="small" label={branch} sx={{ height: 20 }} />
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
              No commits yet.
            </Typography>
          )}
          {commits.map(c => {
            const isLive = !!publishedSha && c.oid === publishedSha;
            const isHead = c.oid === headOid;
            const isOpen = expanded === c.oid;
            const files = commitFiles?.[c.oid];
            return (
              <Box key={c.oid} sx={{ borderBottom: 1, borderColor: "divider" }}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 0.5,
                    px: 1,
                    py: 1,
                    cursor: "pointer",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                  onClick={() => toggleFiles(c.oid)}
                >
                  <Box sx={{ pt: 0.25, color: "text.secondary" }}>
                    {isOpen ? (
                      <ExpandIcon size={16} />
                    ) : (
                      <CollapsedIcon size={16} />
                    )}
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.primary",
                        overflowWrap: "anywhere",
                        display: "-webkit-box",
                        WebkitLineClamp: isOpen ? "unset" : 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {c.subject}
                    </Typography>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        mt: 0.25,
                        flexWrap: "wrap",
                      }}
                    >
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: "monospace" }}
                      >
                        {c.oid.slice(0, 7)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.author} · {new Date(c.timestamp).toLocaleString()}
                      </Typography>
                      {isLive && (
                        <Chip
                          size="small"
                          color="success"
                          icon={<LiveIcon size={12} />}
                          label="Live"
                          sx={{ height: 18, fontSize: "0.65rem" }}
                        />
                      )}
                      {isHead && (
                        <Chip
                          size="small"
                          variant="outlined"
                          label="Latest"
                          sx={{ height: 18, fontSize: "0.65rem" }}
                        />
                      )}
                    </Box>
                  </Box>
                  <Tooltip title="Actions">
                    <IconButton
                      size="small"
                      onClick={e => {
                        e.stopPropagation();
                        setMenu({ anchor: e.currentTarget, commit: c });
                      }}
                    >
                      <MoreIcon size={16} />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Collapse in={isOpen} unmountOnExit>
                  <Box sx={{ pl: 4, pr: 1, pb: 1 }}>
                    {!files ? (
                      <CircularProgress size={14} sx={{ ml: 1, my: 0.5 }} />
                    ) : files.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        No files of this app changed in this commit.
                      </Typography>
                    ) : (
                      files.map(f => (
                        <Box
                          key={f.path}
                          onClick={e => {
                            e.stopPropagation();
                            focusAppsDiffTab(
                              appId,
                              f.path,
                              "commit",
                              slug,
                              c.oid,
                            );
                            onClose();
                          }}
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            px: 1,
                            py: 0.25,
                            borderRadius: 1,
                            cursor: "pointer",
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                        >
                          <Typography
                            variant="caption"
                            sx={{
                              fontFamily: "monospace",
                              width: 12,
                              color:
                                f.status === "deleted"
                                  ? "error.main"
                                  : f.status === "added"
                                    ? "success.main"
                                    : "text.secondary",
                            }}
                          >
                            {STATUS_LETTER[f.status] ?? "M"}
                          </Typography>
                          <Typography
                            variant="caption"
                            sx={{
                              fontFamily: "monospace",
                              color: "text.primary",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {f.path}
                          </Typography>
                          <Box sx={{ flex: 1 }} />
                          <DiffIcon size={13} style={{ opacity: 0.6 }} />
                        </Box>
                      ))
                    )}
                  </Box>
                </Collapse>
              </Box>
            );
          })}
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
            if (menu) setConfirm({ kind: "restore", commit: menu.commit });
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <RestoreIcon size={16} />
          </ListItemIcon>
          <ListItemText
            primary="Restore this version…"
            secondary="New commit on your branch; nothing is lost"
          />
        </MenuItem>
        <MenuItem
          disabled={
            !!menu && !!publishedSha && menu.commit.oid === publishedSha
          }
          onClick={() => {
            if (menu) setConfirm({ kind: "rollback", commit: menu.commit });
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <LiveIcon size={16} />
          </ListItemIcon>
          <ListItemText
            primary="Make this the live version…"
            secondary="Only versions that were published before"
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
        <DialogTitle>
          {confirm?.kind === "restore"
            ? "Restore this version?"
            : "Make this the live version?"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm?.kind === "restore" ? (
              <>
                The app's files go back to what they were in{" "}
                <b>{confirm.commit.subject}</b> (
                <code>{confirm.commit.oid.slice(0, 7)}</code>), as a new commit
                on <b>{branch}</b>. Everything after it stays in the history, so
                this can itself be undone. The live app is not affected until
                you publish.
              </>
            ) : confirm ? (
              <>
                Viewers get the build of{" "}
                <code>{confirm.commit.oid.slice(0, 7)}</code> (
                <b>{confirm.commit.subject}</b>) immediately — no rebuild. This
                only works for versions that were published before; otherwise
                restore it and publish.
              </>
            ) : null}
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
            {busy
              ? "Working…"
              : confirm?.kind === "restore"
                ? "Restore"
                : "Go live"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
