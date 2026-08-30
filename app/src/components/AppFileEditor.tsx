import { useCallback, useEffect, useRef } from "react";
import { Alert, Box, Button, useTheme } from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";
import { focusAppsV2Tab } from "../apps-v2-runtime/shell";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { missingEntityError } from "../lib/entity-labels";

/**
 * Full-screen editor for a single file within an app. Opened as its own tab
 * from the sidebar explorer. Edits update the app's virtual filesystem (which
 * refreshes any open preview tab) and auto-persist.
 */
export default function AppFileEditor({
  tabId,
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

  const appEntity = useAppStore(s => s.openApps[appId]);
  const appLoadError = useAppStore(s => s.openAppErrors[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const writeFile = useAppStore(s => s.writeFile);
  const persistApp = useAppStore(s => s.persistApp);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  const migrated = !!appEntity?.migratedToV2ProjectId;

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (migrated) return; // stamped by the v2 migration — read-only
      writeFile(appId, path, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void persistApp(workspaceId, appId);
        }, 1200);
      }
    },
    [appId, path, workspaceId, writeFile, persistApp, migrated],
  );

  if (!appEntity) {
    if (appLoadError) {
      return (
        <EntityLoadErrorState
          error={appLoadError}
          entityLabel="app"
          onRetry={() => {
            if (workspaceId) void fetchApp(workspaceId, appId);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading file…" />;
  }

  const file = appEntity.files.find(f => f.path === path);
  if (!file) {
    return (
      <EntityLoadErrorState
        error={missingEntityError("file")}
        entityLabel="file"
        detail={`${path} no longer exists in this app.`}
      />
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EntityBreadcrumbs tabId={tabId} />
      {migrated && (
        <Alert
          severity="info"
          sx={{ borderRadius: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() =>
                focusAppsV2Tab(
                  appEntity.migratedToV2ProjectId ?? "",
                  appEntity.title,
                )
              }
            >
              Open in Apps
            </Button>
          }
        >
          This app moved to Apps v2 — this copy is read-only.
        </Alert>
      )}
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
            readOnly: migrated,
          }}
        />
      </Box>
    </Box>
  );
}
