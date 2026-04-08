import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Drawer,
  Dialog,
  DialogContent,
  DialogTitle,
  Box,
  Typography,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Chip,
  Button,
  CircularProgress,
  Divider,
  Menu,
  Collapse,
} from "@mui/material";
import {
  Plus,
  Trash2,
  RefreshCw,
  Database,
  Search,
  X,
  Pencil,
  CheckCircle2,
  XCircle,
  LoaderCircle,
  FileCode,
  Import,
  ChevronUp,
  Eye,
} from "lucide-react";
import {
  useDashboardStore,
  type MaterializationRunRecord,
} from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { apiClient } from "../../lib/api-client";
import { DataGridPremium, type GridColDef } from "@mui/x-data-grid-premium";
import {
  createDashboardDataSource,
  importConsoleAsDashboardDataSource,
  reloadDashboardDataSourcesCommand,
  refreshDashboardDataSourceCommand,
  removeDashboardDataSource,
  updateDashboardDataSourceQuery,
  previewDashboardQuery,
} from "../../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../../dashboard-runtime/store";
import { useSchemaStore } from "../../store/schemaStore";

interface ConsoleResult {
  id: string;
  title: string;
  connectionName?: string;
  language?: string;
}

interface DataSourcePanelProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

const STATUS_CHIP_PROPS: Record<
  "idle" | "loading" | "ready" | "error",
  { label: string; color: "warning" | "success" | "error" }
> = {
  idle: { label: "Idle", color: "warning" },
  loading: { label: "Loading", color: "warning" },
  ready: { label: "Ready", color: "success" },
  error: { label: "Error", color: "error" },
};

function formatRelativeTime(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

function formatBytes(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function formatLoadingStatus(options: {
  loadingMessage?: string | null;
  rowsLoaded: number;
  bytesLoaded?: number;
  totalBytes?: number | null;
}): string {
  const baseMessage =
    options.loadingMessage ||
    (options.rowsLoaded > 0
      ? `${options.rowsLoaded.toLocaleString()} rows loaded`
      : "Preparing stream");
  const byteProgress =
    options.totalBytes != null && options.totalBytes > 0
      ? `${formatBytes(options.bytesLoaded) ?? "0 B"} / ${formatBytes(options.totalBytes) ?? "0 B"}`
      : null;
  return [baseMessage, byteProgress].filter(Boolean).join(" · ");
}

function formatAbsoluteTime(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function formatDurationMs(
  startedAt?: string,
  finishedAt?: string,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(finishedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  const totalSeconds = Math.round((endMs - startMs) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const DataSourcePanel: React.FC<DataSourcePanelProps> = ({
  open,
  onClose,
  dashboardId,
}) => {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const dashboard = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId] : undefined,
  );
  const runtimeSession = useDashboardRuntimeStore(state =>
    dashboardId ? state.sessions[dashboardId] || null : null,
  );
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const availableConnections = useSchemaStore(state =>
    workspaceId ? state.connections[workspaceId] || [] : [],
  );
  const fetchMaterializationRuns = useDashboardStore(
    state => state.fetchMaterializationRuns,
  );
  const fetchMaterializationRunDetail = useDashboardStore(
    state => state.fetchMaterializationRunDetail,
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConsoleResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [directName, setDirectName] = useState("");
  const [directConnectionId, setDirectConnectionId] = useState("");
  const [directDatabaseName, setDirectDatabaseName] = useState("");
  const [directLanguage, setDirectLanguage] = useState<
    "sql" | "javascript" | "mongodb"
  >("sql");
  const [directQuery, setDirectQuery] = useState("");
  const [creatingDirect, setCreatingDirect] = useState(false);
  const [editingDataSourceId, setEditingDataSourceId] = useState<string | null>(
    null,
  );
  const [historyDataSourceId, setHistoryDataSourceId] = useState<string | null>(
    null,
  );
  const [historyRuns, setHistoryRuns] = useState<MaterializationRunRecord[]>(
    [],
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<MaterializationRunRecord | null>(null);

  const loadAllConsoles = useCallback(async () => {
    if (!workspaceId) return;
    setSearching(true);
    try {
      const res = await apiClient.get<{
        success: boolean;
        consoles: Array<{
          id: string;
          name: string;
          description?: string;
          language?: string;
          connection?: { id: string; name: string };
        }>;
      }>(`/workspaces/${workspaceId}/consoles/list`);
      setSearchResults(
        (res.consoles ?? []).map(c => ({
          id: String(c.id),
          title: c.name,
          connectionName: c.connection?.name,
          language: c.language,
        })),
      );
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [workspaceId]);

  const [allConsoles, setAllConsoles] = useState<ConsoleResult[]>([]);

  // Load all consoles when panel opens
  useEffect(() => {
    if (!open || !workspaceId) return;
    void ensureConnections(workspaceId);
    loadAllConsoles().then(() => {
      // allConsoles will be set by the next effect
    });
  }, [open, workspaceId, loadAllConsoles, ensureConnections]);

  // Keep a copy of the full list for client-side filtering
  useEffect(() => {
    if (searchResults.length > 0 && !searchQuery.trim()) {
      setAllConsoles(searchResults);
    }
  }, [searchResults, searchQuery]);

  // Client-side filter when typing
  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      if (allConsoles.length > 0) setSearchResults(allConsoles);
      return;
    }
    setSearchResults(
      allConsoles.filter(
        c =>
          c.title.toLowerCase().includes(q) ||
          (c.connectionName || "").toLowerCase().includes(q),
      ),
    );
  }, [searchQuery, allConsoles]);

  const handleAddDataSource = async (console_: ConsoleResult) => {
    if (!dashboard || !workspaceId) return;

    setAddingId(console_.id);

    try {
      await importConsoleAsDashboardDataSource({
        workspaceId,
        consoleId: console_.id,
        name: console_.title.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
      });
    } finally {
      setAddingId(null);
    }

    setSearchQuery("");
    setSearchResults([]);
  };

  const handleRemoveDataSource = async (dsId: string) => {
    if (!workspaceId) return;

    setRemovingId(dsId);

    try {
      await removeDashboardDataSource({ workspaceId, dataSourceId: dsId });
    } finally {
      setRemovingId(null);
    }
  };

  const handleRefreshDataSource = async (dsId: string) => {
    if (!workspaceId) return;
    await refreshDashboardDataSourceCommand({
      workspaceId,
      dataSourceId: dsId,
    });
  };

  const openHistory = async (dataSourceId: string) => {
    if (!workspaceId || !dashboardId) return;
    setHistoryDataSourceId(dataSourceId);
    setHistoryLoading(true);
    try {
      const runs = await fetchMaterializationRuns(
        workspaceId,
        dashboardId,
        dataSourceId,
      );
      setHistoryRuns(runs);
      const firstRunId = runs[0]?.runId ?? null;
      setSelectedRunId(firstRunId);
      if (firstRunId) {
        const detail = await fetchMaterializationRunDetail(
          workspaceId,
          dashboardId,
          firstRunId,
        );
        setSelectedRunDetail(detail);
      } else {
        setSelectedRunDetail(null);
      }
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSelectRun = async (runId: string) => {
    if (!workspaceId || !dashboardId) return;
    setSelectedRunId(runId);
    setHistoryLoading(true);
    try {
      const detail = await fetchMaterializationRunDetail(
        workspaceId,
        dashboardId,
        runId,
      );
      setSelectedRunDetail(detail);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleCreateDirectDataSource = async () => {
    if (
      !workspaceId ||
      !directName.trim() ||
      !directConnectionId ||
      !directQuery.trim()
    ) {
      return;
    }

    setCreatingDirect(true);
    try {
      if (editingDataSourceId) {
        await updateDashboardDataSourceQuery({
          workspaceId,
          dataSourceId: editingDataSourceId,
          dashboardId,
          rematerialize: true,
          changes: {
            name: directName.trim(),
            query: {
              connectionId: directConnectionId,
              language: directLanguage,
              code: directQuery,
              databaseName: directDatabaseName || undefined,
            },
          },
        });
      } else {
        await createDashboardDataSource({
          workspaceId,
          name: directName.trim(),
          query: {
            connectionId: directConnectionId,
            language: directLanguage,
            code: directQuery,
            databaseName: directDatabaseName || undefined,
          },
        });
      }
      setDirectName("");
      setDirectConnectionId("");
      setDirectDatabaseName("");
      setDirectLanguage("sql");
      setDirectQuery("");
      setEditingDataSourceId(null);
      setAddMode(null);
    } finally {
      setCreatingDirect(false);
    }
  };

  const handleEditDataSource = (dataSourceId: string): boolean => {
    const ds = dashboard?.dataSources.find(
      source => source.id === dataSourceId,
    );
    if (!ds) {
      return false;
    }

    setEditingDataSourceId(ds.id);
    setDirectName(ds.name);
    setDirectConnectionId(ds.query.connectionId);
    setDirectDatabaseName(ds.query.databaseName || "");
    setDirectLanguage(ds.query.language);
    setDirectQuery(ds.query.code);
    return true;
  };

  const resetDirectForm = () => {
    setEditingDataSourceId(null);
    setDirectName("");
    setDirectConnectionId("");
    setDirectDatabaseName("");
    setDirectLanguage("sql");
    setDirectQuery("");
  };

  const [previewDataSourceId, setPreviewDataSourceId] = useState<string | null>(
    null,
  );
  const [previewDataSourceName, setPreviewDataSourceName] = useState("");
  const [previewData, setPreviewData] = useState<{
    rows: Record<string, unknown>[];
    fields: Array<{ name: string; type: string }>;
    rowCount: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const handlePreviewDataSource = async (
    dataSourceId: string,
    dataSourceName: string,
  ) => {
    if (!dashboardId) return;
    setPreviewDataSourceId(dataSourceId);
    setPreviewDataSourceName(dataSourceName);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const result = await previewDashboardQuery({
        dataSourceId,
        dashboardId,
        sql: undefined,
      });
      setPreviewData(result);
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Failed to load preview data",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewDataSourceId(null);
    setPreviewData(null);
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const previewColumns = useMemo<GridColDef[]>(() => {
    if (!previewData?.fields?.length && !previewData?.rows?.length) return [];

    const fields = previewData.fields;
    if (fields.length > 0) {
      return fields.map(f => {
        const sampleValues = previewData.rows
          .slice(0, 20)
          .map(r => r[f.name])
          .filter(v => v !== undefined && v !== null);
        const isNumeric =
          sampleValues.length > 0 &&
          sampleValues.every(v => typeof v === "number");
        const maxLen = Math.max(
          f.name.length,
          ...sampleValues.map(v =>
            typeof v === "object" ? JSON.stringify(v).length : String(v).length,
          ),
          0,
        );
        return {
          field: f.name,
          headerName: f.name,
          width: Math.min(Math.max(maxLen * 8 + 24, 80), 400),
          align: isNumeric ? ("right" as const) : ("left" as const),
          headerAlign: isNumeric ? ("right" as const) : ("left" as const),
          renderCell: (params: { value: unknown }) => {
            const val = params.value;
            if (val === null) return "null";
            if (val === undefined) return "";
            if (typeof val === "object") return JSON.stringify(val);
            return String(val);
          },
        };
      });
    }

    const keys = new Set<string>();
    previewData.rows.slice(0, 50).forEach(r => {
      Object.keys(r).forEach(k => keys.add(k));
    });
    return Array.from(keys).map(k => ({
      field: k,
      headerName: k,
      width: 150,
    }));
  }, [previewData]);

  const previewRows = useMemo(() => {
    if (!previewData?.rows) return [];
    return previewData.rows.map((row, i) => ({
      ...row,
      __preview_id: row.id !== undefined ? `${row.id}_${i}` : i,
    }));
  }, [previewData]);

  const [addMode, setAddMode] = useState<null | "scratch" | "import">(null);
  const [addMenuAnchor, setAddMenuAnchor] = useState<null | HTMLElement>(null);

  const closeAddPanel = () => {
    setAddMode(null);
    resetDirectForm();
    setSearchQuery("");
  };

  const handleStartEdit = (dataSourceId: string) => {
    if (handleEditDataSource(dataSourceId)) {
      setAddMode("scratch");
    }
  };

  const dataSources = dashboard?.dataSources ?? [];
  const hasBuildingMaterialization = dataSources.some(
    dataSource =>
      dataSource.cache?.parquetBuildStatus === "building" ||
      dataSource.cache?.parquetBuildStatus === "queued",
  );

  const showAddPanel = addMode !== null || editingDataSourceId !== null;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: { width: 420, p: 0, display: "flex", flexDirection: "column" },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Database size={18} />
          <Typography variant="subtitle1" fontWeight={600}>
            Data Sources
          </Typography>
          <Chip
            label={dataSources.length}
            size="small"
            sx={{ height: 20, fontSize: "0.75rem", ml: 0.5 }}
          />
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <IconButton
            size="small"
            onClick={e => setAddMenuAnchor(e.currentTarget)}
            color="primary"
          >
            <Plus size={18} />
          </IconButton>
          <Menu
            anchorEl={addMenuAnchor}
            open={Boolean(addMenuAnchor)}
            onClose={() => setAddMenuAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <MenuItem
              onClick={() => {
                setAddMenuAnchor(null);
                resetDirectForm();
                setAddMode("scratch");
              }}
            >
              <FileCode size={16} style={{ marginRight: 8 }} />
              From scratch
            </MenuItem>
            <MenuItem
              onClick={() => {
                setAddMenuAnchor(null);
                resetDirectForm();
                setAddMode("import");
              }}
            >
              <Import size={16} style={{ marginRight: 8 }} />
              From a saved console
            </MenuItem>
          </Menu>
          <IconButton size="small" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </Box>
      </Box>

      <Divider />

      {/* Collapsible Add/Edit Panel */}
      <Collapse in={showAddPanel}>
        <Box sx={{ bgcolor: "action.hover" }}>
          {(addMode === "scratch" || editingDataSourceId) && (
            <Box sx={{ px: 2, py: 1.5 }}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  mb: 1,
                }}
              >
                <Typography
                  variant="caption"
                  fontWeight={600}
                  color="text.secondary"
                >
                  {editingDataSourceId ? "Edit Data Source" : "New Data Source"}
                </Typography>
                <IconButton size="small" onClick={closeAddPanel}>
                  <ChevronUp size={16} />
                </IconButton>
              </Box>
              <TextField
                size="small"
                fullWidth
                label="Name"
                value={directName}
                onChange={e => setDirectName(e.target.value)}
                sx={{ mb: 1 }}
              />
              <FormControl size="small" fullWidth sx={{ mb: 1 }}>
                <InputLabel>Connection</InputLabel>
                <Select
                  value={directConnectionId}
                  label="Connection"
                  onChange={e => setDirectConnectionId(e.target.value)}
                >
                  {availableConnections.map(connection => (
                    <MenuItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Box sx={{ display: "flex", gap: 1, mb: 1 }}>
                <FormControl size="small" sx={{ minWidth: 120 }}>
                  <InputLabel>Language</InputLabel>
                  <Select
                    value={directLanguage}
                    label="Language"
                    onChange={e =>
                      setDirectLanguage(
                        e.target.value as "sql" | "javascript" | "mongodb",
                      )
                    }
                  >
                    <MenuItem value="sql">SQL</MenuItem>
                    <MenuItem value="javascript">JavaScript</MenuItem>
                    <MenuItem value="mongodb">MongoDB</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  size="small"
                  fullWidth
                  label="Database Name (optional)"
                  value={directDatabaseName}
                  onChange={e => setDirectDatabaseName(e.target.value)}
                />
              </Box>
              <TextField
                size="small"
                fullWidth
                multiline
                minRows={3}
                maxRows={8}
                label="Query"
                value={directQuery}
                onChange={e => setDirectQuery(e.target.value)}
                sx={{ mb: 1 }}
                slotProps={{
                  input: { sx: { fontFamily: "monospace", fontSize: 13 } },
                }}
              />
              <Box sx={{ display: "flex", gap: 1 }}>
                <Button
                  size="small"
                  variant="contained"
                  fullWidth
                  disabled={
                    creatingDirect ||
                    !directName.trim() ||
                    !directConnectionId ||
                    !directQuery.trim()
                  }
                  onClick={handleCreateDirectDataSource}
                >
                  {creatingDirect
                    ? editingDataSourceId
                      ? "Saving..."
                      : "Creating..."
                    : editingDataSourceId
                      ? "Save"
                      : "Create"}
                </Button>
                <Button size="small" variant="text" onClick={closeAddPanel}>
                  Cancel
                </Button>
              </Box>
            </Box>
          )}

          {addMode === "import" && !editingDataSourceId && (
            <Box sx={{ px: 2, py: 1.5 }}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  mb: 1,
                }}
              >
                <Typography
                  variant="caption"
                  fontWeight={600}
                  color="text.secondary"
                >
                  Import Saved Console
                </Typography>
                <IconButton size="small" onClick={closeAddPanel}>
                  <ChevronUp size={16} />
                </IconButton>
              </Box>
              <TextField
                size="small"
                fullWidth
                placeholder="Search saved consoles…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                slotProps={{
                  input: {
                    startAdornment: (
                      <Search
                        size={16}
                        style={{ marginRight: 8, opacity: 0.5 }}
                      />
                    ),
                    endAdornment: searching ? (
                      <CircularProgress size={16} />
                    ) : searchQuery ? (
                      <IconButton
                        size="small"
                        onClick={() => {
                          setSearchQuery("");
                          setSearchResults([]);
                        }}
                      >
                        <X size={14} />
                      </IconButton>
                    ) : null,
                  },
                }}
              />

              {searchResults.length > 0 && (
                <List dense sx={{ maxHeight: 200, overflow: "auto", mt: 0.5 }}>
                  {searchResults.map(c => (
                    <ListItem
                      key={c.id}
                      sx={{
                        borderRadius: 1,
                        "&:hover": { bgcolor: "background.paper" },
                        cursor: "pointer",
                        pr: 6,
                      }}
                      onClick={() => handleAddDataSource(c)}
                    >
                      <ListItemText
                        primary={c.title}
                        secondary={
                          [c.connectionName, c.language]
                            .filter(Boolean)
                            .join(" · ") || undefined
                        }
                        primaryTypographyProps={{
                          variant: "body2",
                          noWrap: true,
                        }}
                        secondaryTypographyProps={{ variant: "caption" }}
                      />
                      <ListItemSecondaryAction>
                        {addingId === c.id ? (
                          <CircularProgress size={18} />
                        ) : (
                          <IconButton
                            size="small"
                            onClick={() => handleAddDataSource(c)}
                          >
                            <Plus size={16} />
                          </IconButton>
                        )}
                      </ListItemSecondaryAction>
                    </ListItem>
                  ))}
                </List>
              )}

              {searchQuery.trim().length >= 2 &&
                !searching &&
                searchResults.length === 0 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 1, display: "block" }}
                  >
                    No consoles found. Try a different search.
                  </Typography>
                )}
            </Box>
          )}

          <Divider />
        </Box>
      </Collapse>

      {/* Data Sources List (primary content) */}
      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 1 }}>
        {dataSources.length === 0 ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              py: 6,
              gap: 1.5,
            }}
          >
            <Database size={32} style={{ opacity: 0.25 }} />
            <Typography variant="body2" color="text.secondary">
              No data sources yet
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<Plus size={14} />}
              onClick={e => setAddMenuAnchor(e.currentTarget)}
            >
              Add data source
            </Button>
          </Box>
        ) : (
          <Box>
            {dataSources.map(ds => {
              const runtimeDataSource = runtimeSession?.dataSources[ds.id];
              const status = runtimeDataSource?.status;
              const loadedRows =
                runtimeDataSource?.rowsLoaded ||
                runtimeDataSource?.rowCount ||
                ds.cache?.rowCount ||
                0;
              const errorMessage = runtimeDataSource?.error;
              const chipProps = status ? STATUS_CHIP_PROPS[status] : null;
              const materializationStatus =
                ds.cache?.parquetBuildStatus || "missing";
              const materializationPending =
                materializationStatus === "queued" ||
                materializationStatus === "building";
              const materializedAt = formatRelativeTime(
                ds.cache?.parquetBuiltAt,
              );
              const sizeLabel = formatBytes(ds.cache?.byteSize);
              const materializationError =
                materializationStatus === "error"
                  ? ds.cache?.parquetLastError || null
                  : null;
              const diagnostics = [
                runtimeDataSource?.activeSource
                  ? `source: ${runtimeDataSource.activeSource}`
                  : null,
                runtimeDataSource?.resolvedMode
                  ? `mode: ${runtimeDataSource.resolvedMode}`
                  : null,
                runtimeDataSource?.loadPath
                  ? `path: ${runtimeDataSource.loadPath}`
                  : null,
                runtimeDataSource?.artifactRevision
                  ? `artifact: ${runtimeDataSource.artifactRevision}`
                  : null,
                runtimeDataSource?.loadDurationMs
                  ? `load: ${Math.round(runtimeDataSource.loadDurationMs)} ms`
                  : null,
                runtimeDataSource?.storageBackend
                  ? `store: ${runtimeDataSource.storageBackend}`
                  : null,
              ].filter(Boolean);
              const materializationChip =
                materializationStatus === "ready" ? (
                  <Chip
                    icon={<CheckCircle2 size={14} />}
                    label="Materialized"
                    color="success"
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: "0.7rem" }}
                  />
                ) : materializationStatus === "queued" ? (
                  <Chip
                    icon={<LoaderCircle size={14} />}
                    label="Queued"
                    color="warning"
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: "0.7rem" }}
                  />
                ) : materializationStatus === "building" ? (
                  <Chip
                    icon={<LoaderCircle size={14} />}
                    label="Materializing..."
                    color="warning"
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: "0.7rem" }}
                  />
                ) : materializationStatus === "error" ? (
                  <Chip
                    icon={<XCircle size={14} />}
                    label="Materialization failed"
                    color="error"
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: "0.7rem" }}
                  />
                ) : (
                  <Chip
                    icon={<XCircle size={14} />}
                    label="Not materialized"
                    color="error"
                    size="small"
                    variant="outlined"
                    sx={{ height: 22, fontSize: "0.7rem" }}
                  />
                );

              const rowsLabel =
                loadedRows > 0 ? `${loadedRows.toLocaleString()} rows` : null;
              const statsSegments = [
                rowsLabel,
                sizeLabel,
                materializedAt,
              ].filter(Boolean);

              return (
                <Box
                  key={ds.id}
                  sx={{
                    px: 1.5,
                    py: 1,
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    mb: 1,
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.5,
                    }}
                  >
                    <Typography
                      variant="body2"
                      fontFamily="monospace"
                      fontWeight={600}
                      noWrap
                      sx={{ flex: 1, minWidth: 0 }}
                    >
                      {ds.name}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() => handleRefreshDataSource(ds.id)}
                      disabled={status === "loading" || materializationPending}
                      sx={{ p: 0.5 }}
                    >
                      {status === "loading" ? (
                        <CircularProgress size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handlePreviewDataSource(ds.id, ds.name)}
                      disabled={status === "loading"}
                      sx={{ p: 0.5 }}
                      title="Preview rows"
                    >
                      <Eye size={14} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleStartEdit(ds.id)}
                      sx={{ p: 0.5 }}
                    >
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleRemoveDataSource(ds.id)}
                      disabled={removingId === ds.id}
                      color="error"
                      sx={{ p: 0.5 }}
                    >
                      {removingId === ds.id ? (
                        <CircularProgress size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </IconButton>
                  </Box>

                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.5,
                      mt: 0.5,
                    }}
                  >
                    {materializationChip}
                    {chipProps && (
                      <Chip
                        label={chipProps.label}
                        color={chipProps.color}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: "0.7rem" }}
                      />
                    )}
                  </Box>

                  {(statsSegments.length > 0 ||
                    status === "loading" ||
                    status === "error" ||
                    materializationError) && (
                    <Typography
                      variant="caption"
                      color={
                        status === "error" || materializationError
                          ? "error.main"
                          : "text.secondary"
                      }
                      sx={{ display: "block", mt: 0.5, lineHeight: 1.4 }}
                    >
                      {status === "loading"
                        ? formatLoadingStatus({
                            loadingMessage: runtimeDataSource?.loadingMessage,
                            rowsLoaded: loadedRows,
                            bytesLoaded: runtimeDataSource?.bytesLoaded,
                            totalBytes: runtimeDataSource?.totalBytes,
                          })
                        : status === "error"
                          ? errorMessage || "Failed to load data source"
                          : materializationError
                            ? materializationError
                            : statsSegments.join(" · ")}
                    </Typography>
                  )}

                  {diagnostics.length > 0 && (
                    <Typography
                      variant="caption"
                      color="text.disabled"
                      sx={{
                        display: "block",
                        mt: 0.25,
                        fontFamily: "monospace",
                        fontSize: "0.65rem",
                        lineHeight: 1.3,
                      }}
                    >
                      {diagnostics.join(" · ")}
                    </Typography>
                  )}

                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      mt: 0.5,
                    }}
                  >
                    <Button
                      size="small"
                      sx={{
                        minWidth: 0,
                        fontSize: "0.7rem",
                        textTransform: "none",
                        py: 0,
                        px: 0,
                      }}
                      onClick={() => void openHistory(ds.id)}
                    >
                      Materialization history
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      disabled={status === "loading" || materializationPending}
                      startIcon={
                        materializationPending ? (
                          <CircularProgress size={12} />
                        ) : (
                          <RefreshCw size={12} />
                        )
                      }
                      sx={{
                        minWidth: 0,
                        fontSize: "0.7rem",
                        textTransform: "none",
                        py: 0,
                        px: 0.5,
                      }}
                      onClick={() => handleRefreshDataSource(ds.id)}
                    >
                      Materialize
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Footer with refresh-all */}
      {dataSources.length > 0 && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1, flexShrink: 0 }}>
            <Button
              size="small"
              fullWidth
              variant="outlined"
              startIcon={<RefreshCw size={14} />}
              disabled={hasBuildingMaterialization}
              onClick={() => {
                if (workspaceId) {
                  void reloadDashboardDataSourcesCommand(workspaceId);
                }
              }}
            >
              Refresh All
            </Button>
          </Box>
        </>
      )}

      <Dialog
        open={Boolean(historyDataSourceId)}
        onClose={() => {
          setHistoryDataSourceId(null);
          setHistoryRuns([]);
          setSelectedRunId(null);
          setSelectedRunDetail(null);
        }}
        fullWidth
        maxWidth="lg"
      >
        <DialogTitle>Materialization History</DialogTitle>
        <DialogContent>
          <Box sx={{ display: "flex", gap: 2, minHeight: 420, pt: 1 }}>
            <Box
              sx={{
                width: 280,
                borderRight: theme => `1px solid ${theme.palette.divider}`,
                pr: 2,
              }}
            >
              {historyLoading && historyRuns.length === 0 ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                  <CircularProgress size={24} />
                </Box>
              ) : historyRuns.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No materialization runs yet.
                </Typography>
              ) : (
                <List dense disablePadding>
                  {historyRuns.map(run => (
                    <ListItem
                      key={run.runId}
                      disablePadding
                      sx={{ mb: 0.5, display: "block" }}
                    >
                      <Button
                        fullWidth
                        variant={
                          selectedRunId === run.runId ? "contained" : "text"
                        }
                        color={
                          run.status === "error"
                            ? "error"
                            : run.status === "ready"
                              ? "success"
                              : "warning"
                        }
                        onClick={() => void handleSelectRun(run.runId)}
                        sx={{ justifyContent: "flex-start" }}
                      >
                        <Box sx={{ textAlign: "left" }}>
                          <Typography variant="caption" display="block">
                            {run.triggerType}
                          </Typography>
                          <Typography variant="body2">
                            {formatAbsoluteTime(run.requestedAt) || run.runId}
                          </Typography>
                        </Box>
                      </Button>
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              {!selectedRunDetail ? (
                <Typography variant="body2" color="text.secondary">
                  Select a run to inspect details.
                </Typography>
              ) : (
                <Box
                  sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}
                >
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <Chip
                      label={selectedRunDetail.status}
                      color={
                        selectedRunDetail.status === "error"
                          ? "error"
                          : selectedRunDetail.status === "ready"
                            ? "success"
                            : "warning"
                      }
                      size="small"
                    />
                    <Chip
                      label={selectedRunDetail.triggerType}
                      variant="outlined"
                      size="small"
                    />
                  </Box>
                  <Typography variant="body2">
                    Requested:{" "}
                    {formatAbsoluteTime(selectedRunDetail.requestedAt) || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Started:{" "}
                    {formatAbsoluteTime(selectedRunDetail.startedAt) || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Finished:{" "}
                    {formatAbsoluteTime(selectedRunDetail.finishedAt) || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Duration:{" "}
                    {formatDurationMs(
                      selectedRunDetail.startedAt,
                      selectedRunDetail.finishedAt,
                    ) || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Definition Hash: {selectedRunDetail.definitionHash || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Artifact Revision:{" "}
                    {selectedRunDetail.artifactRevision || "N/A"}
                  </Typography>
                  <Typography variant="body2">
                    Rows:{" "}
                    {selectedRunDetail.rowCount?.toLocaleString() || "unknown"}
                  </Typography>
                  <Typography variant="body2">
                    Size: {formatBytes(selectedRunDetail.byteSize) || "unknown"}
                  </Typography>
                  {selectedRunDetail.error && (
                    <Typography variant="body2" color="error.main">
                      Error: {selectedRunDetail.error}
                    </Typography>
                  )}

                  <Divider />

                  <Typography variant="subtitle2">Events</Typography>
                  <List dense disablePadding>
                    {selectedRunDetail.events.map((event, index) => (
                      <ListItem
                        key={`${event.timestamp}-${event.type}-${index}`}
                        sx={{ px: 0, alignItems: "flex-start" }}
                      >
                        <ListItemText
                          primary={event.message}
                          primaryTypographyProps={{ variant: "body2" }}
                          secondary={
                            <>
                              <Typography variant="caption" display="block">
                                {event.type} ·{" "}
                                {formatAbsoluteTime(event.timestamp) || "N/A"}
                              </Typography>
                              {event.metadata && (
                                <Typography
                                  variant="caption"
                                  component="pre"
                                  sx={{
                                    mt: 0.5,
                                    mb: 0,
                                    whiteSpace: "pre-wrap",
                                    fontFamily: "monospace",
                                  }}
                                >
                                  {JSON.stringify(event.metadata, null, 2)}
                                </Typography>
                              )}
                            </>
                          }
                          secondaryTypographyProps={{ component: "div" }}
                        />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Box>
          </Box>
        </DialogContent>
      </Dialog>

      {/* Data Source Preview Dialog */}
      <Dialog
        open={Boolean(previewDataSourceId)}
        onClose={closePreview}
        fullWidth
        maxWidth="lg"
        PaperProps={{ sx: { height: "80vh" } }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            py: 1.5,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Eye size={18} />
            <Typography variant="subtitle1" fontWeight={600} component="span">
              Preview:{" "}
              <Typography
                component="span"
                fontFamily="monospace"
                fontWeight={600}
              >
                {previewDataSourceName}
              </Typography>
            </Typography>
            {previewData && (
              <Chip
                label={`${previewData.rowCount} row${previewData.rowCount === 1 ? "" : "s"}`}
                size="small"
                sx={{ ml: 1, height: 22, fontSize: "0.75rem" }}
              />
            )}
          </Box>
          <IconButton size="small" onClick={closePreview}>
            <X size={18} />
          </IconButton>
        </DialogTitle>
        <Divider />
        <DialogContent sx={{ p: 0, display: "flex", flexDirection: "column" }}>
          {previewLoading && (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CircularProgress size={32} />
            </Box>
          )}
          {previewError && (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: 1,
              }}
            >
              <XCircle size={32} style={{ opacity: 0.4 }} />
              <Typography variant="body2" color="error.main">
                {previewError}
              </Typography>
            </Box>
          )}
          {!previewLoading && !previewError && previewData && (
            <Box sx={{ flex: 1, minHeight: 0 }}>
              {previewRows.length === 0 ? (
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    No rows returned
                  </Typography>
                </Box>
              ) : (
                <DataGridPremium
                  rows={previewRows}
                  columns={previewColumns}
                  getRowId={row => row.__preview_id}
                  density="compact"
                  disableRowSelectionOnClick
                  hideFooter
                  columnHeaderHeight={40}
                  rowHeight={36}
                  sx={{
                    height: "100%",
                    border: "none",
                    "& .MuiDataGrid-cell": {
                      fontSize: "12px",
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      borderRight: "1px solid",
                      borderColor: "divider",
                    },
                    "& .MuiDataGrid-columnHeaders": {
                      backgroundColor: "background.default",
                      fontFamily: "monospace",
                    },
                    "& .MuiDataGrid-columnHeader": {
                      backgroundColor: "background.default",
                      fontFamily: "monospace",
                    },
                  }}
                />
              )}
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </Drawer>
  );
};

export default DataSourcePanel;
