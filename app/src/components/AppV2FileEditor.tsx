import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, useTheme } from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { appV2FileKey, useAppV2Store } from "../store/appV2Store";
import { useConsoleStore } from "../store/consoleStore";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { confirmAppV2RemoteLoad } from "../apps-v2-runtime/close-guard";

export default function AppV2FileEditor({
  tabId,
  projectId,
  path,
}: {
  tabId: string;
  projectId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const key = appV2FileKey(projectId, path);
  const file = useAppV2Store(state => state.filesByKey[key]);
  const buffer = useAppV2Store(state => state.editorBuffersByKey[key]);
  const project = useAppV2Store(state => state.projectsById[projectId]);
  const fileError = useAppV2Store(state => state.errorsByKey[`file:${key}`]);
  const conflict = useAppV2Store(state => state.conflictsByKey[key]);
  const getProject = useAppV2Store(state => state.getProject);
  const getOrCreateWorktree = useAppV2Store(state => state.getOrCreateWorktree);
  const loadTree = useAppV2Store(state => state.loadTree);
  const loadFile = useAppV2Store(state => state.loadFile);
  const reloadFile = useAppV2Store(state => state.reloadFile);
  const updateEditorBuffer = useAppV2Store(state => state.updateEditorBuffer);
  const saveFile = useAppV2Store(state => state.saveFile);
  const clearConflict = useAppV2Store(state => state.clearConflict);
  const [saving, setSaving] = useState(false);
  const updateDirty = useConsoleStore(state => state.updateDirty);
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const snapshot = useAppV2Store.getState();
      const [, loadedWorktree] = await Promise.all([
        snapshot.projectsById[projectId]
          ? Promise.resolve(snapshot.projectsById[projectId])
          : getProject(workspaceId, projectId),
        snapshot.worktreesByProject[projectId]
          ? Promise.resolve(snapshot.worktreesByProject[projectId])
          : getOrCreateWorktree(workspaceId, projectId),
      ]);
      if (!cancelled && loadedWorktree) {
        await Promise.all([
          loadTree(workspaceId, projectId),
          loadFile(workspaceId, projectId, path),
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    getOrCreateWorktree,
    getProject,
    loadFile,
    loadTree,
    path,
    projectId,
    workspaceId,
  ]);

  useEffect(() => {
    updateDirty(tabId, buffer?.dirty === true);
  }, [buffer?.dirty, tabId, updateDirty]);

  const handleSave = useCallback(async () => {
    if (!workspaceId || !buffer?.dirty || project?.readOnly) return;
    setSaving(true);
    await saveFile(workspaceId, projectId, path);
    setSaving(false);
  }, [
    buffer?.dirty,
    path,
    project?.readOnly,
    projectId,
    saveFile,
    workspaceId,
  ]);

  const handleLoadRemote = useCallback(async () => {
    if (!workspaceId) return;
    if (
      !confirmAppV2RemoteLoad(buffer?.dirty === true, message =>
        window.confirm(message),
      )
    ) {
      return;
    }
    await reloadFile(workspaceId, projectId, path, { discardDirty: true });
  }, [buffer?.dirty, path, projectId, reloadFile, workspaceId]);

  if (!file || !buffer) {
    if (fileError) {
      return (
        <EntityLoadErrorState
          error={{ message: fileError }}
          entityLabel="file"
          detail={path}
          onRetry={() => {
            if (workspaceId) void loadFile(workspaceId, projectId, path);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading file…" />;
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EntityBreadcrumbs
        tabId={tabId}
        trailing={
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {buffer.dirty ? <Chip size="small" label="Unsaved" /> : null}
            <Button
              size="small"
              variant="contained"
              disabled={!buffer.dirty || saving || project?.readOnly}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </Box>
        }
      />
      {project?.readOnly ? (
        <Alert severity="info" sx={{ borderRadius: 0 }}>
          You have read-only access to this project.
        </Alert>
      ) : null}
      {buffer.remoteUpdate ? (
        <Alert
          severity="warning"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => void handleLoadRemote()}
            >
              Load remote version
            </Button>
          }
          sx={{ borderRadius: 0 }}
        >
          The worktree changed remotely. Reload to use the latest version
          {buffer.dirty ? "; your unsaved edits remain unchanged" : ""}.
        </Alert>
      ) : null}
      {conflict ? (
        <Alert
          severity="warning"
          onClose={() => clearConflict(key)}
          sx={{ borderRadius: 0 }}
        >
          {conflict.message} Your local edits remain in the editor.
        </Alert>
      ) : null}
      {fileError ? (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {fileError}
        </Alert>
      ) : null}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor
          height="100%"
          path={`apps-v2/${projectId}/${path}`}
          language={languageForPath(path)}
          value={buffer.content}
          theme={monacoTheme}
          beforeMount={configureMonacoForJsx}
          onChange={value => {
            updateEditorBuffer(projectId, path, value ?? "");
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            readOnly: project?.readOnly,
          }}
        />
      </Box>
    </Box>
  );
}
