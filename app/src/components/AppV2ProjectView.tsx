import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppV2Store, type AppV2TreeEntry } from "../store/appV2Store";
import { useConsoleStore } from "../store/consoleStore";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { buildAppV2FileNodes } from "../apps-v2-runtime/tree";
import { APP_V2_FILE_SEP, APP_V2_DIR_SEP } from "../lib/explorer-reveal";
import { focusAppV2FileTab } from "../apps-v2-runtime/shell";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import AppV2CommandPanel from "./AppV2CommandPanel";
import AppV2GitHubSection from "./AppV2GitHubSection";

const EMPTY_ENTRIES: AppV2TreeEntry[] = [];
const AppV2ProjectIcon = TAB_KIND_ICONS["app-v2"];
const AppV2FileIcon = TAB_KIND_ICONS["app-v2-file"];

function fileIcon(_node: ResourceTreeNode) {
  return <AppV2FileIcon size={16} strokeWidth={1.5} />;
}

export default function AppV2ProjectView({
  tabId,
  projectId,
}: {
  tabId: string;
  projectId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const project = useAppV2Store(state => state.projectsById[projectId]);
  const worktree = useAppV2Store(state => state.worktreesByProject[projectId]);
  const entries = useAppV2Store(
    state => state.treesByProject[projectId] ?? EMPTY_ENTRIES,
  );
  const gitStatus = useAppV2Store(state => state.statusByProject[projectId]);
  const conversationBranches = useAppV2Store(
    state => state.conversationBranchesByProject[projectId] ?? [],
  );
  const projectError = useAppV2Store(
    state => state.errorsByKey[`project:${projectId}`],
  );
  const conflict = useAppV2Store(state => state.conflictsByKey[projectId]);
  const getProject = useAppV2Store(state => state.getProject);
  const getOrCreateWorktree = useAppV2Store(state => state.getOrCreateWorktree);
  const listConversationBranches = useAppV2Store(
    state => state.listConversationBranches,
  );
  const loadTree = useAppV2Store(state => state.loadTree);
  const loadStatus = useAppV2Store(state => state.loadStatus);
  const commit = useAppV2Store(state => state.commit);
  const discard = useAppV2Store(state => state.discard);
  const clearConflict = useAppV2Store(state => state.clearConflict);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [mutating, setMutating] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const snapshot = useAppV2Store.getState();
      const [loadedProject, loadedWorktree] = await Promise.all([
        snapshot.projectsById[projectId]
          ? Promise.resolve(snapshot.projectsById[projectId])
          : getProject(workspaceId, projectId),
        snapshot.worktreesByProject[projectId]
          ? Promise.resolve(snapshot.worktreesByProject[projectId])
          : getOrCreateWorktree(workspaceId, projectId),
        listConversationBranches(workspaceId, projectId),
      ]);
      if (loadedProject && !cancelled) {
        useConsoleStore.getState().updateTitle(tabId, loadedProject.title);
      }
      if (loadedWorktree && !cancelled) {
        await Promise.all([
          loadTree(workspaceId, projectId),
          loadStatus(workspaceId, projectId),
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    getOrCreateWorktree,
    getProject,
    loadStatus,
    loadTree,
    listConversationBranches,
    projectId,
    tabId,
    workspaceId,
  ]);

  const fileNodes = useMemo(
    () => buildAppV2FileNodes(projectId, entries),
    [entries, projectId],
  );

  const handleCommit = useCallback(async () => {
    if (!workspaceId || !message.trim() || project?.readOnly) return;
    setMutating(true);
    const result = await commit(workspaceId, projectId, message.trim());
    setMutating(false);
    if (result === "saved") setMessage("");
  }, [commit, message, project?.readOnly, projectId, workspaceId]);

  const handleDiscard = useCallback(async () => {
    if (
      !workspaceId ||
      project?.readOnly ||
      !window.confirm("Discard all uncommitted changes in your worktree?")
    ) {
      return;
    }
    setMutating(true);
    await discard(workspaceId, projectId);
    setMutating(false);
  }, [discard, project?.readOnly, projectId, workspaceId]);

  if (!project) {
    if (projectError) {
      return (
        <EntityLoadErrorState
          error={{ message: projectError }}
          entityLabel="app project"
          onRetry={() => {
            if (workspaceId) void getProject(workspaceId, projectId);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading App Project…" />;
  }

  return (
    <Box
      sx={{
        height: "100%",
        overflow: "auto",
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {conflict ? (
        <Alert severity="warning" onClose={() => clearConflict(projectId)}>
          {conflict.message} Refresh before retrying; no local change was
          overwritten.
        </Alert>
      ) : null}

      <Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <AppV2ProjectIcon size={22} />
          <Typography variant="h5">{project.title}</Typography>
          <Chip size="small" label={project.access} />
          {project.readOnly ? <Chip size="small" label="Read only" /> : null}
        </Box>
        {project.description ? (
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            {project.description}
          </Typography>
        ) : null}
      </Box>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" gutterBottom>
          Git-backed worktree
        </Typography>
        {worktree ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 1,
            }}
          >
            <Typography variant="body2">Branch: {worktree.branch}</Typography>
            <Typography variant="body2">
              Head: {project.headSha.slice(0, 10)}
            </Typography>
            <Typography variant="body2">
              WIP: {worktree.wipOid.slice(0, 10)}
            </Typography>
            <Typography variant="body2">
              Revision: {worktree.revision}
            </Typography>
            <Typography variant="body2">
              Lease epoch: {worktree.leaseEpoch}
            </Typography>
            <Typography variant="body2">
              Status: {gitStatus?.clean ? "Clean" : "Uncommitted changes"}
            </Typography>
          </Box>
        ) : (
          <Typography color="text.secondary">
            Preparing your personal worktree…
          </Typography>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" gutterBottom>
          Conversation branches
        </Typography>
        {conversationBranches.length > 0 ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            {conversationBranches.map(branch => (
              <Box
                key={branch.chatId}
                sx={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(180px, 1fr) minmax(100px, auto) minmax(100px, auto)",
                  gap: 1,
                }}
              >
                <Typography variant="body2">{branch.branch}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {branch.lastCommitSha
                    ? `Commit ${branch.lastCommitSha.slice(0, 10)}`
                    : `WIP ${branch.wipOid.slice(0, 10)}`}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {branch.status}
                </Typography>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No agent conversation branches yet.
          </Typography>
        )}
      </Paper>

      {workspaceId ? (
        <AppV2GitHubSection
          workspaceId={workspaceId}
          project={project}
          branches={conversationBranches}
        />
      ) : null}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "minmax(260px, 1fr) 1fr" },
          gap: 2,
          minHeight: 280,
        }}
      >
        <Paper variant="outlined" sx={{ overflow: "auto" }}>
          <Typography variant="subtitle2" sx={{ p: 1.5, pb: 1 }}>
            Scaffold files
          </Typography>
          <Divider />
          <ResourceTree
            sections={[
              {
                key: "files",
                label: "Files",
                hideSectionHeader: true,
                nodes: fileNodes,
              },
            ]}
            getItemIcon={fileIcon}
            onItemClick={node => {
              if (node.id.includes(APP_V2_FILE_SEP)) {
                focusAppV2FileTab(projectId, node.path);
              }
            }}
            isFolderExpanded={key => expanded.has(key)}
            onToggleFolder={key =>
              setExpanded(current => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onExpandFolder={key =>
              setExpanded(current => new Set(current).add(key))
            }
            getFolderExpansionKey={node =>
              node.id.includes(APP_V2_DIR_SEP) ? node.id : node.path
            }
            enableDragDrop={false}
            enableRename={false}
            enableDelete={false}
            enableNewFolder={false}
          />
        </Paper>

        <Paper
          variant="outlined"
          sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}
        >
          <Typography variant="subtitle2">Uncommitted changes</Typography>
          {gitStatus?.changes.length ? (
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {gitStatus.changes.map(change => (
                <Typography component="li" variant="body2" key={change.path}>
                  {change.status} {change.path}
                </Typography>
              ))}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Worktree is clean.
            </Typography>
          )}
          <TextField
            label="Commit message"
            value={message}
            onChange={event => setMessage(event.target.value)}
            multiline
            minRows={2}
            disabled={project.readOnly}
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              disabled={
                project.readOnly ||
                mutating ||
                !message.trim() ||
                gitStatus?.clean !== false
              }
              onClick={() => void handleCommit()}
            >
              Commit
            </Button>
            <Button
              color="warning"
              disabled={
                project.readOnly || mutating || gitStatus?.clean !== false
              }
              onClick={() => void handleDiscard()}
            >
              Discard
            </Button>
          </Box>
        </Paper>
      </Box>

      {workspaceId ? (
        <AppV2CommandPanel
          workspaceId={workspaceId}
          projectId={projectId}
          readOnly={project.readOnly}
        />
      ) : null}
    </Box>
  );
}
