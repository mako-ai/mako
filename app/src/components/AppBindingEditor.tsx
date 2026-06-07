import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Typography,
  Button,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
  Tooltip,
} from "@mui/material";
import {
  ChevronRight as BreadcrumbChevronIcon,
  Database as MaterializeIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppStore } from "../store/appStore";
import { useConsoleStore } from "../store/consoleStore";
import Console from "./Console";
import ResultsTable from "./ResultsTable";

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

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json" | "chart">("table");
  const [running, setRunning] = useState(false);
  const [materializing, setMaterializing] = useState(false);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  const binding = appEntity?.dataBindings.find(b => b.id === bindingId);

  const handleExecute = useCallback(
    async (content: string, connectionId?: string, databaseId?: string) => {
      if (!workspaceId || !connectionId) return;
      setRunning(true);
      try {
        const res = await executeQuery(workspaceId, connectionId, content, {
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
    [workspaceId, executeQuery, binding?.databaseName],
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
    await materializeBinding(workspaceId, appId, bindingId);
    setMaterializing(false);
  }, [workspaceId, appId, bindingId, materializeBinding]);

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
  const breadcrumb = ["Apps", appEntity.title, "Data sources", binding.name];

  const headerExtras = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, ml: 1 }}>
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
        <ToggleButton value="live" sx={{ textTransform: "none", py: 0.25 }}>
          Live
        </ToggleButton>
        <ToggleButton value="parquet" sx={{ textTransform: "none", py: 0.25 }}>
          Parquet · DuckDB
        </ToggleButton>
      </ToggleButtonGroup>
      {binding.materialization === "parquet" && (
        <>
          <Tooltip title="Materialize to Parquet and load into DuckDB">
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<MaterializeIcon size={16} strokeWidth={1.5} />}
                onClick={handleMaterialize}
                disabled={materializing}
              >
                {materializing ? "Materializing…" : "Materialize"}
              </Button>
            </span>
          </Tooltip>
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
        </>
      )}
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
