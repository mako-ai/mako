import React, { useState, useEffect, useCallback } from "react";
import {
  Drawer,
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
} from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { apiClient } from "../../lib/api-client";
import {
  createDashboardDataSource,
  importConsoleAsDashboardDataSource,
  reloadDashboardDataSourcesCommand,
  refreshDashboardDataSourceCommand,
  removeDashboardDataSource,
  updateDashboardDataSourceQuery,
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
    } finally {
      setCreatingDirect(false);
    }
  };

  const handleEditDataSource = (dataSourceId: string) => {
    const ds = dashboard?.dataSources.find(
      source => source.id === dataSourceId,
    );
    if (!ds) {
      return;
    }

    setEditingDataSourceId(ds.id);
    setDirectName(ds.name);
    setDirectConnectionId(ds.query.connectionId);
    setDirectDatabaseName(ds.query.databaseName || "");
    setDirectLanguage(ds.query.language);
    setDirectQuery(ds.query.code);
  };

  const resetDirectForm = () => {
    setEditingDataSourceId(null);
    setDirectName("");
    setDirectConnectionId("");
    setDirectDatabaseName("");
    setDirectLanguage("sql");
    setDirectQuery("");
  };

  const dataSources = dashboard?.dataSources ?? [];

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: 380, p: 0 } }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Database size={18} />
          <Typography variant="subtitle1" fontWeight={600}>
            Data Sources
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </Box>

      <Divider />

      {/* Search / Add Section */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mb: 0.5, display: "block" }}
        >
          {editingDataSourceId ? "Edit Data Source" : "New Data Source"}
        </Typography>
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
          <FormControl size="small" sx={{ minWidth: 130 }}>
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
          minRows={4}
          maxRows={10}
          label="Query"
          value={directQuery}
          onChange={e => setDirectQuery(e.target.value)}
          sx={{ mb: 1 }}
          slotProps={{
            input: { sx: { fontFamily: "monospace", fontSize: 13 } },
          }}
        />
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
              ? "Save data source"
              : "Create data source"}
        </Button>
        {editingDataSourceId && (
          <Button
            size="small"
            fullWidth
            variant="text"
            sx={{ mt: 1 }}
            onClick={resetDirectForm}
          >
            Cancel edit
          </Button>
        )}
      </Box>

      <Divider />

      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mb: 0.5, display: "block" }}
        >
          Import Saved Console
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="Search saved consoles…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <Search size={16} style={{ marginRight: 8, opacity: 0.5 }} />
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
          <List dense sx={{ maxHeight: 220, overflow: "auto", mt: 0.5 }}>
            {searchResults.map(c => (
              <ListItem
                key={c.id}
                sx={{
                  borderRadius: 1,
                  "&:hover": { bgcolor: "action.hover" },
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
                  primaryTypographyProps={{ variant: "body2", noWrap: true }}
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
              {searchQuery.trim()
                ? "No consoles found. Try a different search."
                : "No saved consoles in this workspace."}
            </Typography>
          )}
      </Box>

      <Divider />

      {/* Attached Data Sources */}
      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 1 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mb: 0.5, display: "block" }}
        >
          Attached ({dataSources.length})
        </Typography>

        {dataSources.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 2, textAlign: "center" }}
          >
            No data sources attached yet.
          </Typography>
        ) : (
          <List dense disablePadding>
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
              const materializedAt = formatRelativeTime(
                ds.cache?.parquetBuiltAt,
              );
              const sizeLabel = formatBytes(ds.cache?.byteSize);
              const diagnostics = [
                runtimeDataSource?.resolvedMode
                  ? `mode: ${runtimeDataSource.resolvedMode}`
                  : null,
                runtimeDataSource?.loadPath
                  ? `path: ${runtimeDataSource.loadPath}`
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
                ) : materializationStatus === "building" ? (
                  <Chip
                    icon={<LoaderCircle size={14} />}
                    label="Materializing..."
                    color="warning"
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

              return (
                <ListItem
                  key={ds.id}
                  sx={{
                    borderRadius: 1,
                    mb: 0.5,
                    pr: 10,
                  }}
                >
                  <ListItemText
                    primary={ds.name}
                    primaryTypographyProps={{
                      variant: "body2",
                      fontFamily: "monospace",
                    }}
                    secondary={
                      <Box sx={{ mt: 0.25 }}>
                        {status === "loading" ? (
                          <Typography variant="caption" color="text.secondary">
                            {loadedRows > 0
                              ? `${loadedRows.toLocaleString()} rows loaded...`
                              : "Starting stream..."}
                          </Typography>
                        ) : status === "ready" && loadedRows > 0 ? (
                          <Typography variant="caption" color="text.secondary">
                            {loadedRows.toLocaleString()} rows loaded
                          </Typography>
                        ) : status === "error" ? (
                          <Typography
                            variant="caption"
                            color="error.main"
                            sx={{ display: "block", maxWidth: 220 }}
                          >
                            {errorMessage || "Failed to load data source"}
                          </Typography>
                        ) : null}
                        <Typography
                          variant="caption"
                          color={
                            materializationStatus === "ready"
                              ? "success.main"
                              : materializationStatus === "building"
                                ? "warning.main"
                                : "text.secondary"
                          }
                          sx={{ display: "block", mt: 0.25 }}
                        >
                          {materializationStatus === "ready"
                            ? "Materialized"
                            : materializationStatus === "building"
                              ? "Materializing..."
                              : "Not materialized"}
                          {materializedAt
                            ? ` · Last materialized ${materializedAt}`
                            : ""}
                          {ds.cache?.rowCount
                            ? ` · ${ds.cache.rowCount.toLocaleString()} rows`
                            : ""}
                          {sizeLabel ? ` · ${sizeLabel}` : ""}
                        </Typography>
                        {diagnostics.length > 0 && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: "block",
                              mt: 0.25,
                              fontFamily: "monospace",
                            }}
                          >
                            {diagnostics.join(" · ")}
                          </Typography>
                        )}
                      </Box>
                    }
                    secondaryTypographyProps={{ component: "div" }}
                  />
                  <ListItemSecondaryAction
                    sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                  >
                    {materializationChip}
                    {chipProps && (
                      <Chip
                        label={chipProps.label}
                        color={chipProps.color}
                        size="small"
                        variant="outlined"
                        sx={{ height: 22, fontSize: "0.7rem" }}
                      />
                    )}
                    <IconButton
                      size="small"
                      onClick={() => handleRefreshDataSource(ds.id)}
                      disabled={status === "loading"}
                    >
                      {status === "loading" ? (
                        <CircularProgress size={16} />
                      ) : (
                        <RefreshCw size={15} />
                      )}
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleEditDataSource(ds.id)}
                    >
                      <Pencil size={15} />
                    </IconButton>
                    <IconButton
                      size="small"
                      onClick={() => handleRemoveDataSource(ds.id)}
                      disabled={removingId === ds.id}
                      color="error"
                    >
                      {removingId === ds.id ? (
                        <CircularProgress size={16} />
                      ) : (
                        <Trash2 size={15} />
                      )}
                    </IconButton>
                  </ListItemSecondaryAction>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      {/* Footer with refresh-all */}
      {dataSources.length > 0 && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1.5 }}>
            <Button
              size="small"
              fullWidth
              variant="outlined"
              startIcon={<RefreshCw size={14} />}
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
    </Drawer>
  );
};

export default DataSourcePanel;
