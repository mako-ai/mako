import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Typography,
  Chip,
  Button,
  ToggleButtonGroup,
  ToggleButton,
  Tooltip,
  useTheme,
} from "@mui/material";
import { Play as RunIcon, Database as MaterializeIcon } from "lucide-react";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useSchemaStore } from "../store/schemaStore";
import { useAppStore } from "../store/appStore";
import {
  ensureBindingLoaded,
  queryAppDuckDB,
  bindingTableName,
} from "../app-runtime/duckdb";
import { ConnectionSelector } from "./ConnectionSelector";

const PREVIEW_LIMIT = 200;

function monacoLanguage(language: string): string {
  if (language === "mongodb" || language === "javascript") return "javascript";
  return "sql";
}

interface PreviewState {
  rows: Record<string, unknown>[];
  columns: string[];
  error: string | null;
  loading: boolean;
}

export default function AppBindingEditor({
  appId,
  bindingId,
}: {
  appId: string;
  bindingId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const appEntity = useAppStore(s => s.openApps[appId]);
  const fetchApp = useAppStore(s => s.fetchApp);
  const updateBinding = useAppStore(s => s.updateBinding);
  const persistApp = useAppStore(s => s.persistApp);
  const runBinding = useAppStore(s => s.runBinding);
  const materializeBinding = useAppStore(s => s.materializeBinding);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!appEntity && workspaceId) void fetchApp(workspaceId, appId);
  }, [appEntity, workspaceId, appId, fetchApp]);

  useEffect(() => {
    if (workspaceId) void ensureConnections(workspaceId);
  }, [workspaceId, ensureConnections]);

  const binding = appEntity?.dataBindings.find(b => b.id === bindingId);

  const persistSoon = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (workspaceId) {
      saveTimer.current = setTimeout(() => {
        void persistApp(workspaceId, appId);
      }, 1000);
    }
  }, [workspaceId, appId, persistApp]);

  const handleCodeChange = useCallback(
    (value: string | undefined) => {
      updateBinding(appId, bindingId, { code: value ?? "" });
      persistSoon();
    },
    [appId, bindingId, updateBinding, persistSoon],
  );

  const handleRun = useCallback(async () => {
    if (!binding || !workspaceId) return;
    setPreview({ rows: [], columns: [], error: null, loading: true });
    try {
      if (binding.materialization === "parquet") {
        const loaded = await ensureBindingLoaded(appId, binding);
        if (!loaded) {
          setPreview({
            rows: [],
            columns: [],
            error: "Not materialized yet — click Materialize first.",
            loading: false,
          });
          return;
        }
        const result = await queryAppDuckDB(
          appId,
          `SELECT * FROM "${bindingTableName(binding.name)}" LIMIT ${PREVIEW_LIMIT}`,
        );
        setPreview({
          rows: result.rows,
          columns: result.fields.map(f => f.name),
          error: null,
          loading: false,
        });
      } else {
        const result = await runBinding(workspaceId, appId, binding.name);
        const rows = (result.rows as Record<string, unknown>[]) || [];
        setPreview({
          rows: rows.slice(0, PREVIEW_LIMIT),
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          error: result.success ? null : result.error || "Query failed",
          loading: false,
        });
      }
    } catch (e) {
      setPreview({
        rows: [],
        columns: [],
        error: e instanceof Error ? e.message : "Query failed",
        loading: false,
      });
    }
  }, [binding, workspaceId, appId, runBinding]);

  const handleMaterialize = useCallback(async () => {
    if (!workspaceId) return;
    setMaterializing(true);
    await materializeBinding(workspaceId, appId, bindingId);
    setMaterializing(false);
    void handleRun();
  }, [workspaceId, appId, bindingId, materializeBinding, handleRun]);

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

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {binding.name}
        </Typography>
        <ConnectionSelector
          value={binding.connectionId}
          onChange={connectionId => {
            updateBinding(appId, bindingId, { connectionId });
            persistSoon();
          }}
          size="compact"
          showLabel={false}
          width={220}
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={binding.materialization}
          onChange={(_e, value) => {
            if (value) {
              updateBinding(appId, bindingId, { materialization: value });
              persistSoon();
            }
          }}
        >
          <ToggleButton value="live">Live</ToggleButton>
          <ToggleButton value="parquet">Parquet · DuckDB</ToggleButton>
        </ToggleButtonGroup>

        <Box sx={{ flex: 1 }} />

        {binding.materialization === "parquet" && (
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
        )}
        <Button
          size="small"
          variant="contained"
          startIcon={<RunIcon size={16} strokeWidth={1.5} />}
          onClick={handleRun}
          disabled={preview?.loading}
        >
          Run
        </Button>
      </Box>

      {/* Materialization status */}
      {binding.materialization === "parquet" && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1.5,
            py: 0.5,
            borderBottom: "1px solid",
            borderColor: "divider",
            fontSize: "0.75rem",
            color: "text.secondary",
            flexWrap: "wrap",
          }}
        >
          <Chip
            size="small"
            variant="outlined"
            color={
              cache?.parquetBuildStatus === "ready"
                ? "success"
                : cache?.parquetBuildStatus === "error"
                  ? "error"
                  : "default"
            }
            label={`status: ${cache?.parquetBuildStatus ?? "missing"}`}
          />
          <Typography variant="caption">
            table: <code>{bindingTableName(binding.name)}</code>
          </Typography>
          {cache?.rowCount != null && (
            <Typography variant="caption">
              {cache.rowCount.toLocaleString()} rows
            </Typography>
          )}
          {cache?.lastRefreshedAt && (
            <Typography variant="caption">
              refreshed {new Date(cache.lastRefreshedAt).toLocaleString()}
            </Typography>
          )}
          {cache?.parquetLastError && (
            <Typography variant="caption" color="error">
              {cache.parquetLastError}
            </Typography>
          )}
        </Box>
      )}

      {/* Query editor + results split */}
      <Box
        sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <MonacoEditor
            height="100%"
            path={`${appId}/binding/${bindingId}`}
            language={monacoLanguage(binding.language)}
            value={binding.code}
            theme={monacoTheme}
            onChange={handleCodeChange}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        </Box>

        {/* Results */}
        <Box
          sx={{
            height: "45%",
            minHeight: 0,
            borderTop: "1px solid",
            borderColor: "divider",
            overflow: "auto",
            bgcolor: "background.paper",
          }}
        >
          {!preview ? (
            <Box sx={{ p: 2, color: "text.secondary" }}>
              <Typography variant="caption">
                Run the query to preview its data.
              </Typography>
            </Box>
          ) : preview.loading ? (
            <Box sx={{ p: 2, color: "text.secondary" }}>
              <Typography variant="caption">Running…</Typography>
            </Box>
          ) : preview.error ? (
            <Box sx={{ p: 2 }}>
              <Typography
                variant="caption"
                color="error"
                sx={{ whiteSpace: "pre-wrap" }}
              >
                {preview.error}
              </Typography>
            </Box>
          ) : (
            <Box
              component="table"
              sx={{
                borderCollapse: "collapse",
                fontSize: "0.78rem",
                width: "max-content",
                minWidth: "100%",
              }}
            >
              <Box component="thead">
                <Box component="tr">
                  {preview.columns.map(col => (
                    <Box
                      key={col}
                      component="th"
                      sx={{
                        textAlign: "left",
                        px: 1,
                        py: 0.5,
                        borderBottom: "1px solid",
                        borderColor: "divider",
                        position: "sticky",
                        top: 0,
                        bgcolor: "background.paper",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {preview.rows.map((row, i) => (
                  <Box component="tr" key={i}>
                    {preview.columns.map(col => (
                      <Box
                        key={col}
                        component="td"
                        sx={{
                          px: 1,
                          py: 0.25,
                          borderBottom: "1px solid",
                          borderColor: "divider",
                          whiteSpace: "nowrap",
                          maxWidth: 360,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {formatCell(row[col])}
                      </Box>
                    ))}
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
