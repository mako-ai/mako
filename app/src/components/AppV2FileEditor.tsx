/**
 * Apps v2 file editor — one file per tab (v1 `AppFileEditor` parity).
 *
 * Reads resolve through the durable worktree API (git, never a sandbox);
 * edits autosave with a debounce, each save flushing to the actor's private
 * WIP ref so nothing is lost if the tab or the sandbox dies.
 */
import { useCallback, useEffect, useRef } from "react";
import { Box, Typography, useTheme } from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsV2Store } from "../store/appsV2Store";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";

export default function AppV2FileEditor({
  tabId: _tabId,
  appId,
  path,
}: {
  tabId: string;
  appId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const fileEntry = useAppsV2Store(
    s => s.fileContents[`${appId}\u0000${path}`],
  );
  const apps = useAppsV2Store(s => s.apps);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const openFile = useAppsV2Store(s => s.openFile);
  const updateFileLocal = useAppsV2Store(s => s.updateFileLocal);
  const saveFile = useAppsV2Store(s => s.saveFile);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    // Title/breadcrumb data for deep links + the file contents themselves.
    if (apps.length === 0) void fetchApps(workspaceId);
    void openFile(workspaceId, appId, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId, path]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      updateFileLocal(appId, path, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void saveFile(workspaceId, appId, path);
        }, 1000);
      }
    },
    [appId, path, workspaceId, updateFileLocal, saveFile],
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {fileEntry ? (
          <MonacoEditor
            height="100%"
            path={`apps-v2/${appId}/${path}`}
            language={languageForPath(path)}
            value={fileEntry.contents}
            theme={monacoTheme}
            beforeMount={configureMonacoForJsx}
            onChange={handleChange}
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
              Loading {path}...
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
