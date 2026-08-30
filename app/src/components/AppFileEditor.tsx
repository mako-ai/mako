/**
 * Apps file editor — one file per tab (v1 `AppFileEditor` parity).
 *
 * Reads resolve through the durable worktree API (git, never a sandbox);
 * edits autosave with a debounce, each save flushing to the actor's private
 * WIP ref so nothing is lost if the tab or the sandbox dies.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, Typography, useTheme } from "@mui/material";
import { Database as DatabaseIcon, Play as PlayIcon } from "lucide-react";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsStore } from "../store/appsStore";
import {
  configureMonacoForJsx,
  languageForPath,
} from "../app-runtime/monaco-jsx";

/** Leading `-- key: value` front-matter block of a binding file. */
function parseFrontMatter(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "--") continue;
    const m = trimmed.match(/^--\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) {
      if (trimmed.startsWith("--")) continue;
      break;
    }
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

export default function AppFileEditor({
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

  const fileEntry = useAppsStore(s => s.fileContents[`${appId}\u0000${path}`]);
  const apps = useAppsStore(s => s.apps);
  const fetchApps = useAppsStore(s => s.fetchApps);
  const openFile = useAppsStore(s => s.openFile);
  const updateFileLocal = useAppsStore(s => s.updateFileLocal);
  const materializeAppBinding = useAppsStore(s => s.materializeAppBinding);
  const saveFile = useAppsStore(s => s.saveFile);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Binding files get a console-style toolbar (Block 3 of the bindings plan;
  // connection picker + Run-through-console-engine are the next slice).
  const isBinding = /^bindings\/[^/]+\.sql$/.test(path);
  const bindingName = isBinding
    ? path.replace(/^bindings\//, "").replace(/\.sql$/, "")
    : null;
  const frontMatter =
    isBinding && fileEntry ? parseFrontMatter(fileEntry.contents) : {};
  const [materializing, setMaterializing] = useState(false);
  const [matResult, setMatResult] = useState<string | null>(null);
  const [matError, setMatError] = useState<string | null>(null);

  const handleMaterialize = useCallback(async () => {
    if (!workspaceId || !bindingName) return;
    setMaterializing(true);
    setMatError(null);
    setMatResult(null);
    try {
      const body = (await materializeAppBinding(
        workspaceId,
        appId,
        bindingName,
      )) as { rowCount?: number };
      setMatResult(`Materialized — ${body.rowCount ?? "?"} rows`);
    } catch (e) {
      setMatError(e instanceof Error ? e.message : "Materialization failed");
    } finally {
      setMaterializing(false);
    }
  }, [workspaceId, appId, bindingName, materializeAppBinding]);

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
      {isBinding && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <DatabaseIcon size={15} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {bindingName}
          </Typography>
          {frontMatter.connection ? (
            <Chip
              size="small"
              variant="outlined"
              label={`connection ${frontMatter.connection.slice(0, 8)}…`}
            />
          ) : (
            <Chip size="small" color="warning" label="no -- connection:" />
          )}
          {frontMatter.schedule && (
            <Chip
              size="small"
              variant="outlined"
              label={`cron ${frontMatter.schedule}`}
            />
          )}
          <Box sx={{ flex: 1 }} />
          {matResult && (
            <Typography variant="caption" color="success.main">
              {matResult}
            </Typography>
          )}
          <Button
            size="small"
            variant="contained"
            startIcon={<PlayIcon size={13} />}
            disabled={materializing || !frontMatter.connection}
            onClick={() => void handleMaterialize()}
          >
            {materializing ? "Materializing…" : "Materialize"}
          </Button>
        </Box>
      )}
      {matError && (
        <Alert severity="error" onClose={() => setMatError(null)}>
          {matError}
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {fileEntry ? (
          <MonacoEditor
            height="100%"
            path={`apps/${appId}/${path}`}
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
