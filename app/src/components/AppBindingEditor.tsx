import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Tooltip,
} from "@mui/material";
import { Info as InfoIcon } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import { useConsoleStore } from "../store/consoleStore";
import { previewParquetArtifact } from "../lib/parquet-preview";
import Console from "./Console";
import ResultsTable from "./ResultsTable";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import DataSourceMaterializationControls, {
  type MaterializationHistoryItem,
} from "./DataSourceMaterializationControls";
import {
  defaultMaterializationSchedule,
  type MaterializationScheduleValue,
} from "../lib/materializationSchedule";

interface PreviewResult {
  results: Record<string, unknown>[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
}

function bindingFilePath(name: string, language: string): string {
  const ext = language === "sql" ? "sql" : "js";
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.${ext}`;
}

/**
 * Data source inspector. Reuses the polished `Console` component (run / save /
 * connection / editor) so app + dashboard data sources look and behave exactly
 * like a saved console, with a small set of data-source-specific controls
 * (materialization) injected into the toolbar.
 */
export default function AppBindingEditor({
  tabId,
  appId,
  bindingId,
}: {
  tabId: string;
  appId: string;
  bindingId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const appEntity = useAppStore(s => s.openApps[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const updateBinding = useAppStore(s => s.updateBinding);
  const persistApp = useAppStore(s => s.persistApp);
  const materializeBinding = useAppStore(s => s.materializeBinding);
  const executeQuery = useConsoleStore(s => s.executeQuery);
  const updateTabTitle = useConsoleStore(s => s.updateTitle);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json" | "chart">("table");
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState(false);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  const binding = appEntity?.dataBindings.find(b => b.id === bindingId);

  // Keep the tab title in sync with the binding name (e.g. when the tab was
  // opened from a deep link with a placeholder title).
  const bindingName = binding?.name;
  useEffect(() => {
    if (bindingName) updateTabTitle(tabId, bindingName);
  }, [bindingName, tabId, updateTabTitle]);

  const resolveDbtCodeForPreview = useAppStore(s => s.resolveDbtCodeForPreview);
  const bindingDbtProjectId = binding?.dbtProjectId;

  const handleExecute = useCallback(
    async (content: string, connectionId?: string, databaseId?: string) => {
      if (!workspaceId || !connectionId) return;
      setRunning(true);
      try {
        // dbt-linked bindings: resolve {{ dbt_schema }} against the app's
        // preview environment (override or prod default) before running.
        const resolved = await resolveDbtCodeForPreview(
          workspaceId,
          appId,
          bindingDbtProjectId,
          content,
        );
        const res = await executeQuery(workspaceId, connectionId, resolved, {
          databaseId,
          databaseName: binding?.databaseName,
        });
        if (res.success) {
          setPreview({
            results: res.rows || [],
            executedAt: new Date().toISOString(),
            resultCount: res.rows?.length ?? 0,
            executionTime: res.executionTime,
            fields: res.fields,
          });
        } else {
          setPreview({
            results: [{ error: res.error || "Query failed" }],
            executedAt: new Date().toISOString(),
            resultCount: 0,
          });
        }
      } finally {
        setRunning(false);
      }
    },
    [
      workspaceId,
      appId,
      executeQuery,
      binding?.databaseName,
      bindingDbtProjectId,
      resolveDbtCodeForPreview,
    ],
  );

  const handleSave = useCallback(
    async (content: string) => {
      if (!workspaceId) return false;
      updateBinding(appId, bindingId, { code: content });
      await persistApp(workspaceId, appId);
      return true;
    },
    [workspaceId, appId, bindingId, updateBinding, persistApp],
  );

  const handleMaterialize = useCallback(async () => {
    if (!workspaceId) return;
    setMaterializing(true);
    // Explicit user action = rebuild now. Force past the definition-hash cache
    // so a rematerialize picks up new upstream data even when the query text is
    // unchanged (parity with the dashboard data source Materialize button).
    await materializeBinding(workspaceId, appId, bindingId, { force: true });
    setMaterializing(false);
  }, [workspaceId, appId, bindingId, materializeBinding]);

  const bindingCache = binding?.cache;
  const handleScheduleChange = useCallback(
    (schedule: MaterializationScheduleValue) => {
      if (!workspaceId) return;
      updateBinding(appId, bindingId, { materializationSchedule: schedule });
      void persistApp(workspaceId, appId);
    },
    [workspaceId, appId, bindingId, updateBinding, persistApp],
  );

  const handlePreviewSnapshot = useCallback(async () => {
    if (!bindingCache?.parquetUrl) return;
    setPreviewingSnapshot(true);
    const startedAt = Date.now();
    try {
      const result = await previewParquetArtifact(bindingCache.parquetUrl);
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
  }, [bindingCache?.parquetUrl]);

  if (!appEntity) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading…</Typography>
      </Box>
    );
  }
  if (!binding) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">
          This data source no longer exists.
        </Typography>
      </Box>
    );
  }

  const cache = binding.cache;

  const historyItems: MaterializationHistoryItem[] = (cache?.history ?? []).map(
    (run, i) => ({
      id: `${run.at}-${i}`,
      status: run.status === "ready" ? "ready" : "error",
      at: run.at,
      rowCount: run.rowCount ?? null,
      durationMs: run.durationMs ?? null,
      error: run.error ?? null,
    }),
  );

  const isParquet = binding.materialization === "parquet";

  const leadingControls = (
    <>
      <Typography variant="caption" color="text.secondary">
        Data
      </Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={binding.materialization}
        onChange={(_e, value) => {
          if (value && workspaceId) {
            updateBinding(appId, bindingId, { materialization: value });
            void persistApp(workspaceId, appId);
          }
        }}
      >
        <ToggleButton value="live">Live</ToggleButton>
        <ToggleButton value="parquet">Materialized</ToggleButton>
      </ToggleButtonGroup>
      <Tooltip
        title={
          <Box sx={{ p: 0.5 }}>
            <Typography variant="caption" display="block" sx={{ mb: 0.5 }}>
              <b>Live</b> — the query runs against the connection on every read.
              Best for small, always-fresh lookups.
            </Typography>
            <Typography variant="caption" display="block">
              <b>Materialized</b> — the query is snapshotted to a Parquet file
              (stored like dashboards) and loaded into DuckDB in the browser, so
              the app can run fast analytical SQL. Click <b>Materialize</b> to
              build/refresh the snapshot.
            </Typography>
          </Box>
        }
      >
        <InfoIcon
          size={15}
          strokeWidth={1.5}
          style={{ opacity: 0.6, cursor: "help" }}
        />
      </Tooltip>
    </>
  );

  const headerExtras = (
    <DataSourceMaterializationControls
      leadingControls={leadingControls}
      showMaterializeControls={isParquet}
      buildStatus={cache?.parquetBuildStatus ?? null}
      rowCount={cache?.rowCount ?? null}
      builtAtMs={
        cache?.parquetBuiltAt ? Date.parse(cache.parquetBuiltAt) : null
      }
      dataFreshnessTtlMs={
        binding.materializationSchedule?.dataFreshnessTtlMs ?? null
      }
      onMaterialize={() => void handleMaterialize()}
      materializing={materializing}
      canPreview={cache?.parquetBuildStatus === "ready" && !!cache?.parquetUrl}
      onPreviewSnapshot={() => void handlePreviewSnapshot()}
      previewing={previewingSnapshot}
      schedule={
        binding.materializationSchedule ?? defaultMaterializationSchedule(false)
      }
      onScheduleChange={handleScheduleChange}
      scheduleCaption="This schedule refreshes only this app data source."
      history={historyItems}
    />
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EntityBreadcrumbs tabId={tabId} />

      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <PanelGroup direction="vertical" style={{ height: "100%" }}>
          <Panel defaultSize={55} minSize={20}>
            <Console
              variant="data-source"
              consoleId={tabId}
              initialContent={binding.code}
              filePath={bindingFilePath(binding.name, binding.language)}
              onExecute={handleExecute}
              onSave={handleSave}
              isExecuting={running}
              connectionId={binding.connectionId}
              onDatabaseChange={connectionId => {
                if (workspaceId) {
                  updateBinding(appId, bindingId, { connectionId });
                  void persistApp(workspaceId, appId);
                }
              }}
              onDatabaseNameChange={(databaseId, databaseName) => {
                if (workspaceId) {
                  updateBinding(appId, bindingId, { databaseId, databaseName });
                  void persistApp(workspaceId, appId);
                }
              }}
              databaseId={binding.databaseId}
              databaseName={binding.databaseName}
              headerExtras={headerExtras}
            />
          </Panel>
          <PanelResizeHandle
            style={{
              height: 4,
              background: "var(--mui-palette-divider, #ddd)",
            }}
          />
          <Panel defaultSize={45} minSize={10}>
            <ResultsTable
              results={preview}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}
