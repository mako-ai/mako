import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Tooltip,
} from "@mui/material";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useDashboardStore,
  type MaterializationRunRecord,
} from "../store/dashboardStore";
import { useConsoleStore } from "../store/consoleStore";
import { previewParquetArtifact } from "../lib/parquet-preview";
import Console from "./Console";
import ResultsTable from "./ResultsTable";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { missingEntityError } from "../lib/entity-labels";
import DataSourceMaterializationControls, {
  type MaterializationHistoryItem,
} from "./DataSourceMaterializationControls";
import type { MaterializationScheduleValue } from "../lib/materializationSchedule";
import { refreshDashboardDataSourceCommand } from "../dashboard-runtime/commands";

interface PreviewResult {
  results: Record<string, unknown>[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
}

function dataSourceFilePath(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.sql`;
}

/**
 * Full-screen editor tab for a dashboard data source — the same experience as
 * app data bindings (Console editor + results + materialization controls),
 * opened from the dashboard's data source panel.
 */
export default function DashboardDataSourceEditor({
  tabId,
  dashboardId,
  dataSourceId,
}: {
  tabId: string;
  dashboardId: string;
  dataSourceId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const dashboard = useDashboardStore(s => s.openDashboards[dashboardId]);
  const dashboardLoadError = useDashboardStore(
    s => s.openDashboardErrors[dashboardId],
  );
  const openDashboard = useDashboardStore(s => s.openDashboard);
  const updateDataSource = useDashboardStore(s => s.updateDataSource);
  const saveDashboard = useDashboardStore(s => s.saveDashboard);
  const fetchMaterializationRuns = useDashboardStore(
    s => s.fetchMaterializationRuns,
  );
  const executeQuery = useConsoleStore(s => s.executeQuery);
  const updateTabTitle = useConsoleStore(s => s.updateTitle);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json" | "chart">("table");
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<MaterializationRunRecord[]>(
    [],
  );

  useEffect(() => {
    if (!dashboard && workspaceId) {
      void openDashboard(workspaceId, dashboardId);
    }
  }, [dashboard, workspaceId, dashboardId, openDashboard]);

  const dataSource = dashboard?.dataSources.find(ds => ds.id === dataSourceId);

  // Keep the tab title in sync with the data source name (e.g. when the tab
  // was opened from a deep link with a placeholder title).
  const dataSourceName = dataSource?.name;
  useEffect(() => {
    if (dataSourceName) updateTabTitle(tabId, dataSourceName);
  }, [dataSourceName, tabId, updateTabTitle]);

  const handleExecute = useCallback(
    async (content: string, connectionId?: string, databaseId?: string) => {
      if (!workspaceId || !connectionId) return;
      setRunning(true);
      try {
        const res = await executeQuery(workspaceId, connectionId, content, {
          databaseId,
          databaseName: dataSource?.query.databaseName,
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
    [workspaceId, executeQuery, dataSource?.query.databaseName],
  );

  const handleSave = useCallback(
    async (content: string) => {
      if (!workspaceId || !dataSource) return false;
      updateDataSource(dashboardId, dataSourceId, {
        query: { ...dataSource.query, code: content },
      });
      const result = await saveDashboard(workspaceId, dashboardId);
      return result.ok;
    },
    [
      workspaceId,
      dashboardId,
      dataSourceId,
      dataSource,
      updateDataSource,
      saveDashboard,
    ],
  );

  const handleMaterialize = useCallback(async () => {
    if (!workspaceId) return;
    setMaterializing(true);
    try {
      // Same contract as the data-source panel Refresh: force rebuild, wait
      // until builds settle, then apply into the dashboard runtime once.
      await refreshDashboardDataSourceCommand({
        workspaceId,
        dataSourceId,
        dashboardId,
      });
    } finally {
      setMaterializing(false);
    }
  }, [workspaceId, dashboardId, dataSourceId]);

  const cache = dataSource?.cache;

  const handleScheduleChange = useCallback(
    (schedule: MaterializationScheduleValue) => {
      if (!workspaceId || !dashboard) return;
      useDashboardStore.setState(state => {
        if (state.openDashboards[dashboardId]) {
          state.openDashboards[dashboardId].materializationSchedule = schedule;
        }
      });
      void saveDashboard(workspaceId, dashboardId);
    },
    [workspaceId, dashboard, dashboardId, saveDashboard],
  );

  const handlePreviewSnapshot = useCallback(async () => {
    if (!workspaceId) return;
    const base = `/api/workspaces/${workspaceId}/dashboards/${dashboardId}/data-sources/${dataSourceId}/materialization/artifact`;
    const url =
      cache?.parquetUrl ||
      (cache?.artifactRevision
        ? `${base}?rev=${encodeURIComponent(cache.artifactRevision)}`
        : base);
    setPreviewingSnapshot(true);
    const startedAt = Date.now();
    try {
      const result = await previewParquetArtifact(url);
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
  }, [workspaceId, dashboardId, dataSourceId, cache]);

  const loadHistory = useCallback(async () => {
    if (!workspaceId) return;
    const runs = await fetchMaterializationRuns(
      workspaceId,
      dashboardId,
      dataSourceId,
    );
    setHistoryRuns(runs);
  }, [workspaceId, dashboardId, dataSourceId, fetchMaterializationRuns]);

  if (!dashboard) {
    if (dashboardLoadError) {
      return (
        <EntityLoadErrorState
          error={dashboardLoadError}
          entityLabel="dashboard"
          onRetry={() => {
            if (workspaceId) void openDashboard(workspaceId, dashboardId);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading data source…" />;
  }
  if (!dataSource) {
    return (
      <EntityLoadErrorState
        error={missingEntityError("data source")}
        entityLabel="data source"
        detail="This data source no longer exists in this dashboard."
      />
    );
  }

  const historyItems: MaterializationHistoryItem[] = historyRuns.map(run => {
    const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
    const startedAt = run.startedAt
      ? new Date(run.startedAt)
      : new Date(run.requestedAt);
    const durationMs =
      finishedAt && startedAt
        ? finishedAt.getTime() - startedAt.getTime()
        : null;
    return {
      id: run.runId,
      status: run.status === "ready" ? "ready" : "error",
      at: run.requestedAt,
      rowCount: run.rowCount ?? null,
      durationMs,
      error: run.error ?? null,
    };
  });

  const isParquet = (dataSource.materialization ?? "parquet") === "parquet";

  // Compact on purpose (shares the toolbar row with run/save/connection): no
  // caption label; the Live/Materialized explanation lives in a tooltip on
  // the toggle itself.
  const leadingControls = (
    <Tooltip
      title={
        <Box sx={{ p: 0.5 }}>
          <Typography variant="caption" display="block" sx={{ mb: 0.5 }}>
            <b>Live</b> — the query streams from the connection each time the
            dashboard loads. Always fresh; not shown in public shares.
          </Typography>
          <Typography variant="caption" display="block">
            <b>Materialized</b> — the query is snapshotted to a Parquet file and
            loaded into DuckDB, so widgets render fast and public viewers get a
            cached snapshot. Click <b>Refresh</b> to rebuild from source.
          </Typography>
        </Box>
      }
    >
      <ToggleButtonGroup
        size="small"
        exclusive
        value={dataSource.materialization ?? "parquet"}
        disabled={dashboard.readOnly}
        onChange={(_e, value) => {
          if (value && workspaceId) {
            updateDataSource(dashboardId, dataSourceId, {
              materialization: value,
            });
            void saveDashboard(workspaceId, dashboardId);
          }
        }}
      >
        <ToggleButton value="live">Live</ToggleButton>
        <ToggleButton value="parquet">Materialized</ToggleButton>
      </ToggleButtonGroup>
    </Tooltip>
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
        dashboard.materializationSchedule?.dataFreshnessTtlMs ?? null
      }
      onMaterialize={() => void handleMaterialize()}
      materializing={materializing}
      canPreview={cache?.parquetBuildStatus === "ready"}
      onPreviewSnapshot={() => void handlePreviewSnapshot()}
      previewing={previewingSnapshot}
      schedule={dashboard.materializationSchedule}
      onScheduleChange={handleScheduleChange}
      scheduleDisabled={dashboard.readOnly}
      scheduleCaption="Dashboard schedules apply to every materialized data source in this dashboard."
      history={historyItems}
      onOpenHistory={loadHistory}
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
              initialContent={dataSource.query.code || ""}
              filePath={dataSourceFilePath(dataSource.name)}
              onExecute={handleExecute}
              onSave={handleSave}
              isExecuting={running}
              connectionId={dataSource.query.connectionId}
              onDatabaseChange={connectionId => {
                if (workspaceId) {
                  updateDataSource(dashboardId, dataSourceId, {
                    query: { ...dataSource.query, connectionId },
                  });
                  void saveDashboard(workspaceId, dashboardId);
                }
              }}
              onDatabaseNameChange={(databaseId, databaseName) => {
                if (workspaceId) {
                  updateDataSource(dashboardId, dataSourceId, {
                    query: { ...dataSource.query, databaseId, databaseName },
                  });
                  void saveDashboard(workspaceId, dashboardId);
                }
              }}
              databaseId={dataSource.query.databaseId}
              databaseName={dataSource.query.databaseName}
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
