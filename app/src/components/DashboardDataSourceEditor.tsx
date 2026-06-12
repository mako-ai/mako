import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Typography,
  Button,
  Chip,
  Tooltip,
  IconButton,
  Popover,
  Divider,
} from "@mui/material";
import {
  ChevronRight as BreadcrumbChevronIcon,
  Database as MaterializeIcon,
  History as HistoryIcon,
  Eye as PreviewIcon,
  CheckCircle2 as SuccessIcon,
  XCircle as ErrorIcon,
} from "lucide-react";
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

interface PreviewResult {
  results: Record<string, unknown>[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
}

const MATERIALIZE_POLL_INTERVAL_MS = 2500;
const MATERIALIZE_POLL_TIMEOUT_MS = 10 * 60 * 1000;

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
  const openDashboard = useDashboardStore(s => s.openDashboard);
  const updateDataSource = useDashboardStore(s => s.updateDataSource);
  const saveDashboard = useDashboardStore(s => s.saveDashboard);
  const materializeDataSource = useDashboardStore(
    s => s.materializeDashboardDataSource,
  );
  const fetchMaterializationStatus = useDashboardStore(
    s => s.fetchDashboardMaterializationStatus,
  );
  const fetchMaterializationRuns = useDashboardStore(
    s => s.fetchMaterializationRuns,
  );
  const executeQuery = useConsoleStore(s => s.executeQuery);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json" | "chart">("table");
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [previewingSnapshot, setPreviewingSnapshot] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  const [historyRuns, setHistoryRuns] = useState<MaterializationRunRecord[]>(
    [],
  );

  useEffect(() => {
    if (!dashboard && workspaceId) {
      void openDashboard(workspaceId, dashboardId);
    }
  }, [dashboard, workspaceId, dashboardId, openDashboard]);

  const dataSource = dashboard?.dataSources.find(ds => ds.id === dataSourceId);

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
      await materializeDataSource(workspaceId, dashboardId, dataSourceId, {
        force: true,
      });
      // Poll until this data source leaves queued/building (status fetch also
      // syncs cache onto the open dashboard, so the chip updates live).
      const deadline = Date.now() + MATERIALIZE_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise(resolve =>
          setTimeout(resolve, MATERIALIZE_POLL_INTERVAL_MS),
        );
        const status = await fetchMaterializationStatus(
          workspaceId,
          dashboardId,
        );
        const sourceStatus = status?.dataSources.find(
          source => source.dataSourceId === dataSourceId,
        );
        if (
          !sourceStatus ||
          (sourceStatus.status !== "queued" &&
            sourceStatus.status !== "building")
        ) {
          break;
        }
      }
    } finally {
      setMaterializing(false);
    }
  }, [
    workspaceId,
    dashboardId,
    dataSourceId,
    materializeDataSource,
    fetchMaterializationStatus,
  ]);

  const cache = dataSource?.cache;

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

  const openHistory = useCallback(
    async (anchor: HTMLElement) => {
      setHistoryAnchor(anchor);
      if (!workspaceId) return;
      const runs = await fetchMaterializationRuns(
        workspaceId,
        dashboardId,
        dataSourceId,
      );
      setHistoryRuns(runs);
    },
    [workspaceId, dashboardId, dataSourceId, fetchMaterializationRuns],
  );

  if (!dashboard) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading…</Typography>
      </Box>
    );
  }
  if (!dataSource) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">
          This data source no longer exists.
        </Typography>
      </Box>
    );
  }

  const breadcrumb = [
    "Dashboards",
    dashboard.title || "Dashboard",
    "Data sources",
    dataSource.name,
  ];

  const headerExtras = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: 1 }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<MaterializeIcon size={16} strokeWidth={1.5} />}
        onClick={() => void handleMaterialize()}
        disabled={materializing}
      >
        {materializing ? "Materializing…" : "Materialize"}
      </Button>
      {cache?.parquetBuildStatus && (
        <Chip
          size="small"
          variant="outlined"
          color={
            cache.parquetBuildStatus === "ready"
              ? "success"
              : cache.parquetBuildStatus === "error"
                ? "error"
                : "default"
          }
          label={
            cache.parquetBuildStatus === "ready" && cache.rowCount != null
              ? `${cache.rowCount.toLocaleString()} rows`
              : cache.parquetBuildStatus
          }
        />
      )}
      {cache?.parquetBuildStatus === "ready" && (
        <Tooltip title="Preview the materialized data">
          <span>
            <IconButton
              size="small"
              onClick={() => void handlePreviewSnapshot()}
              disabled={previewingSnapshot}
            >
              <PreviewIcon size={18} strokeWidth={1.5} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title="Materialization history">
        <IconButton
          size="small"
          onClick={e => void openHistory(e.currentTarget)}
        >
          <HistoryIcon size={18} strokeWidth={1.5} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Breadcrumb — matches the console breadcrumb style */}
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
          gap: 0.25,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        {breadcrumb.map((segment, index) => (
          <Box
            key={`${index}-${segment}`}
            component="span"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.25,
              minWidth: 0,
            }}
          >
            {index > 0 && (
              <BreadcrumbChevronIcon
                size={12}
                strokeWidth={2}
                style={{ flexShrink: 0, opacity: 0.6 }}
              />
            )}
            <Box
              component="span"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {segment}
            </Box>
          </Box>
        ))}
      </Box>

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

      {/* Materialization history */}
      <Popover
        open={Boolean(historyAnchor)}
        anchorEl={historyAnchor}
        onClose={() => setHistoryAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 460 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Materialization history
          </Typography>
          {historyRuns.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No runs yet.
            </Typography>
          ) : (
            historyRuns.map((run, i) => {
              const finishedAt = run.finishedAt
                ? new Date(run.finishedAt)
                : null;
              const startedAt = run.startedAt
                ? new Date(run.startedAt)
                : new Date(run.requestedAt);
              const durationMs =
                finishedAt && startedAt
                  ? finishedAt.getTime() - startedAt.getTime()
                  : null;
              return (
                <Box key={run.runId}>
                  {i > 0 && <Divider sx={{ my: 0.5 }} />}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {run.status === "ready" ? (
                      <SuccessIcon
                        size={16}
                        strokeWidth={1.5}
                        style={{
                          color: "var(--mui-palette-success-main, green)",
                        }}
                      />
                    ) : (
                      <ErrorIcon
                        size={16}
                        strokeWidth={1.5}
                        style={{
                          color: "var(--mui-palette-error-main, crimson)",
                        }}
                      />
                    )}
                    <Typography variant="caption" sx={{ flex: 1 }}>
                      {new Date(run.requestedAt).toLocaleString()}
                    </Typography>
                    {run.status === "ready" && run.rowCount != null && (
                      <Typography variant="caption" color="text.secondary">
                        {run.rowCount.toLocaleString()} rows
                      </Typography>
                    )}
                    {durationMs != null && durationMs >= 0 && (
                      <Typography variant="caption" color="text.secondary">
                        {(durationMs / 1000).toFixed(1)}s
                      </Typography>
                    )}
                  </Box>
                  {run.error && (
                    <Typography
                      variant="caption"
                      color="error"
                      sx={{ display: "block", pl: 3, whiteSpace: "pre-wrap" }}
                    >
                      {run.error}
                    </Typography>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      </Popover>
    </Box>
  );
}
