/**
 * Apps binding editor — the SAME workbench as v1 data sources (the
 * polished Console: run/save/connection picker/highlighting + the
 * materialization controls), but every setting lives in the binding file's
 * front matter instead of Mongo. The editor content IS the file
 * (`bindings/<name>.sql`): changing the connection from the picker rewrites
 * the `-- connection:` line, the cron picker rewrites `-- schedule:`, and
 * saving writes the file to the user's worktree like any other v2 edit.
 */
import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Alert, Box } from "@mui/material";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsStore } from "../store/appsStore";
import { useConsoleStore } from "../store/consoleStore";
import Console from "./Console";
import ResultsTable from "./ResultsTable";
import DataSourceMaterializationControls, {
  type MaterializationHistoryItem,
} from "./DataSourceMaterializationControls";
import {
  defaultMaterializationSchedule,
  type MaterializationScheduleValue,
} from "../lib/materializationSchedule";
import { previewParquetArtifact } from "../lib/parquet-preview";

interface BindingApiState {
  lastMaterializedAt: string | null;
  rowCount: number | null;
  history: Array<{
    at: string;
    status: "ready" | "error";
    rowCount?: number | null;
    durationMs?: number | null;
    error?: string | null;
  }>;
}

interface PreviewResult {
  results: Record<string, unknown>[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
}

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

/** Set/replace/remove a `-- key: value` line in the leading front matter. */
function withFrontMatterKey(
  contents: string,
  key: string,
  value: string | null,
): string {
  const lines = contents.split("\n");
  const re = new RegExp(`^--\\s*${key}\\s*:`, "i");
  const idx = lines.findIndex(l => re.test(l.trim()));
  if (value === null) {
    if (idx >= 0) lines.splice(idx, 1);
    return lines.join("\n");
  }
  const line = `-- ${key}: ${value}`;
  if (idx >= 0) {
    lines[idx] = line;
  } else {
    lines.unshift(line);
  }
  return lines.join("\n");
}

/**
 * Contain grid render failures (e.g. DataGridPremium throwing on an expired
 * MUI X license) to the results panel instead of white-screening the app.
 */
class ResultsErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Alert severity="error" sx={{ m: 2 }}>
          Results grid failed to render: {this.state.error.message}
        </Alert>
      );
    }
    return this.props.children;
  }
}

export default function AppBindingEditor({
  tabId: _tabId,
  appId,
  path,
}: {
  tabId?: string;
  appId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const bindingName = path.replace(/^bindings\//, "").replace(/\.sql$/, "");

  const fileEntry = useAppsStore(s => s.fileContents[`${appId}\u0000${path}`]);
  const apps = useAppsStore(s => s.apps);
  const fetchApps = useAppsStore(s => s.fetchApps);
  const openFile = useAppsStore(s => s.openFile);
  const updateFileLocal = useAppsStore(s => s.updateFileLocal);
  const saveFile = useAppsStore(s => s.saveFile);
  const fetchAppBindings = useAppsStore(s => s.fetchAppBindings);
  const materializeAppBinding = useAppsStore(s => s.materializeAppBinding);
  const executeQuery = useConsoleStore(s => s.executeQuery);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json" | "chart">("table");
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState(false);
  const [bindingState, setBindingState] = useState<BindingApiState | null>(
    null,
  );

  const refreshBindingState = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const bindings = (await fetchAppBindings(
        workspaceId,
        appId,
      )) as unknown as Array<BindingApiState & { name: string }>;
      setBindingState(bindings.find(b => b.name === bindingName) ?? null);
    } catch {
      // Non-fatal: the controls just show no history yet.
    }
  }, [workspaceId, appId, bindingName, fetchAppBindings]);

  useEffect(() => {
    void refreshBindingState();
  }, [refreshBindingState]);

  useEffect(() => {
    if (!workspaceId) return;
    if (apps.length === 0) void fetchApps(workspaceId);
    void openFile(workspaceId, appId, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId, path]);

  const contents = fileEntry?.contents ?? "";
  const frontMatter = parseFrontMatter(contents);
  const connectionId = frontMatter.connection;
  const schedule: MaterializationScheduleValue = frontMatter.schedule
    ? { enabled: true, cron: frontMatter.schedule, timezone: "UTC" }
    : defaultMaterializationSchedule(false);

  const persist = useCallback(
    (next: string) => {
      updateFileLocal(appId, path, next);
      if (workspaceId) void saveFile(workspaceId, appId, path);
    },
    [workspaceId, appId, path, updateFileLocal, saveFile],
  );

  const handleExecute = useCallback(
    async (content: string, connId?: string) => {
      const effective = connId ?? parseFrontMatter(content).connection;
      if (!workspaceId || !effective) return;
      setRunning(true);
      try {
        const res = await executeQuery(workspaceId, effective, content, {});
        setPreview(
          res.success
            ? {
                results: res.rows ?? [],
                executedAt: new Date().toISOString(),
                resultCount: res.rows?.length ?? 0,
                executionTime: res.executionTime,
              }
            : {
                results: [{ error: res.error || "Query failed" }],
                executedAt: new Date().toISOString(),
                resultCount: 0,
              },
        );
      } finally {
        setRunning(false);
      }
    },
    [workspaceId, executeQuery],
  );

  const handleSave = useCallback(
    async (content: string) => {
      persist(content);
      return true;
    },
    [persist],
  );

  const handleMaterialize = useCallback(async () => {
    if (!workspaceId) return;
    setMaterializing(true);
    try {
      await materializeAppBinding(workspaceId, appId, bindingName);
    } finally {
      setMaterializing(false);
      void refreshBindingState();
    }
  }, [
    workspaceId,
    appId,
    bindingName,
    materializeAppBinding,
    refreshBindingState,
  ]);

  const artifactUrl = `/api/workspaces/${workspaceId}/apps/${appId}/bindings/${bindingName}/artifact`;

  const handlePreviewSnapshot = useCallback(async () => {
    setPreviewingSnapshot(true);
    const startedAt = Date.now();
    try {
      const result = await previewParquetArtifact(artifactUrl);
      setPreview({
        results: result.rows,
        executedAt: new Date().toISOString(),
        resultCount: result.totalRows,
        executionTime: Date.now() - startedAt,
        fields: result.fields.map(f => f.name),
      });
      setViewMode("table");
    } catch (e) {
      setPreview({
        results: [
          {
            error:
              e instanceof Error
                ? e.message
                : "Failed to preview the materialized data",
          },
        ],
        executedAt: new Date().toISOString(),
        resultCount: 0,
      });
    } finally {
      setPreviewingSnapshot(false);
    }
  }, [artifactUrl]);

  const handleScheduleChange = useCallback(
    (next: MaterializationScheduleValue) => {
      persist(
        withFrontMatterKey(
          contents,
          "schedule",
          next.enabled && next.cron ? next.cron : null,
        ),
      );
    },
    [contents, persist],
  );

  const historyItems: MaterializationHistoryItem[] = (
    bindingState?.history ?? []
  ).map((run, i) => ({
    id: `${run.at}-${i}`,
    status: run.status === "ready" ? "ready" : "error",
    at: run.at,
    rowCount: run.rowCount ?? null,
    durationMs: run.durationMs ?? null,
    error: run.error ?? null,
  }));

  const lastRun = bindingState?.history?.[0];
  const headerExtras = (
    <DataSourceMaterializationControls
      showMaterializeControls
      buildStatus={
        lastRun ? (lastRun.status === "ready" ? "ready" : "error") : null
      }
      rowCount={bindingState?.rowCount ?? null}
      builtAtMs={
        bindingState?.lastMaterializedAt
          ? Date.parse(bindingState.lastMaterializedAt)
          : null
      }
      dataFreshnessTtlMs={null}
      onMaterialize={() => void handleMaterialize()}
      materializing={materializing}
      canPreview={Boolean(bindingState?.lastMaterializedAt)}
      onPreviewSnapshot={() => void handlePreviewSnapshot()}
      previewing={previewingSnapshot}
      schedule={schedule}
      onScheduleChange={handleScheduleChange}
      scheduleCaption="Stored as '-- schedule:' front matter in this file; the platform refreshes on this cron from the app's main branch."
      history={historyItems}
    />
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <PanelGroup direction="vertical" style={{ height: "100%" }}>
          <Panel defaultSize={55} minSize={20}>
            {fileEntry && (
              <Console
                variant="data-source"
                consoleId={`binding:${appId}:${path}`}
                initialContent={contents}
                filePath={path}
                onExecute={handleExecute}
                onSave={handleSave}
                isExecuting={running}
                connectionId={connectionId}
                onDatabaseChange={connId =>
                  persist(withFrontMatterKey(contents, "connection", connId))
                }
                headerExtras={headerExtras}
              />
            )}
          </Panel>
          <PanelResizeHandle
            style={{
              height: 4,
              background: "var(--mui-palette-divider, #ddd)",
            }}
          />
          <Panel defaultSize={45} minSize={10}>
            <ResultsErrorBoundary key={preview?.executedAt ?? "empty"}>
              <ResultsTable
                results={preview}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            </ResultsErrorBoundary>
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}
