import { useCallback, useEffect, useRef } from "react";
import { Box, Typography, useTheme } from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";

/**
 * Full-screen editor for a single file within an app. Opened as its own tab
 * from the sidebar explorer. Edits update the app's virtual filesystem (which
 * refreshes any open preview tab) and auto-persist.
 */
export default function AppFileEditor({
  appId,
  path,
}: {
  appId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const appEntity = useAppStore(s => s.openApps[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const writeFile = useAppStore(s => s.writeFile);
  const persistApp = useAppStore(s => s.persistApp);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      writeFile(appId, path, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void persistApp(workspaceId, appId);
        }, 1200);
      }
    },
    [appId, path, workspaceId, writeFile, persistApp],
  );

  if (!appEntity) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading file…</Typography>
      </Box>
    );
  }

  const file = appEntity.files.find(f => f.path === path);
  if (!file) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">
          {path} no longer exists in this app.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Breadcrumb */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          minHeight: 22,
          px: 1.5,
          py: 0.25,
          backgroundColor: "background.paper",
          color: "text.secondary",
          fontSize: "0.75rem",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        {appEntity.title} / {path}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor
          height="100%"
          path={`${appId}/${path}`}
          language={languageForPath(path)}
          value={file.contents}
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
      </Box>
    </Box>
  );
}
