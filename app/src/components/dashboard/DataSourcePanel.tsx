import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Drawer,
  Box,
  Typography,
  TextField,
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
import { Plus, Trash2, RefreshCw, Database, Search, X } from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { apiClient } from "../../lib/api-client";
import { initDuckDB, loadArrowTable, dropTable } from "../../lib/duckdb";

interface ConsoleResult {
  id: string;
  title: string;
  connectionName?: string;
  language?: string;
}

interface DataSourcePanelProps {
  open: boolean;
  onClose: () => void;
}

const STATUS_CHIP_PROPS: Record<
  "loading" | "ready" | "error",
  { label: string; color: "warning" | "success" | "error" }
> = {
  loading: { label: "Loading", color: "warning" },
  ready: { label: "Ready", color: "success" },
  error: { label: "Error", color: "error" },
};

const DataSourcePanel: React.FC<DataSourcePanelProps> = ({ open, onClose }) => {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const activeDashboard = useDashboardStore(s => s.activeDashboard);
  const dataSourceStatus = useDashboardStore(s => s.dataSourceStatus);
  const loadDataSource = useDashboardStore(s => s.loadDataSource);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConsoleResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const searchConsolesApi = useCallback(
    async (query: string) => {
      if (!workspaceId) return;
      setSearching(true);
      try {
        const res = await apiClient.get<{
          results: ConsoleResult[];
        }>(
          `/workspaces/${workspaceId}/consoles/search?q=${encodeURIComponent(query)}`,
        );
        setSearchResults(res.results ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [workspaceId],
  );

  const [allConsoles, setAllConsoles] = useState<ConsoleResult[]>([]);

  // Load all consoles when panel opens
  useEffect(() => {
    if (!open || !workspaceId) return;
    loadAllConsoles().then(() => {
      // allConsoles will be set by the next effect
    });
  }, [open, workspaceId, loadAllConsoles]);

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
    const { nanoid } = await import("nanoid");
    const store = useDashboardStore.getState();
    const dashboard = store.activeDashboard;
    if (!dashboard || !workspaceId) return;

    setAddingId(console_.id);

    const dsId = nanoid();
    const newDs: any = {
      id: dsId,
      name: console_.title.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase(),
      consoleId: console_.id,
      cache: { ttlSeconds: 3600 },
    };

    const updatedSources = [...dashboard.dataSources, newDs];
    useDashboardStore.setState(prev => ({
      ...prev,
      activeDashboard: prev.activeDashboard
        ? { ...prev.activeDashboard, dataSources: updatedSources }
        : prev.activeDashboard,
    }));

    try {
      await apiClient.patch(
        `/workspaces/${workspaceId}/dashboards/${dashboard._id}`,
        { dataSources: updatedSources },
      );
    } catch {
      /* non-critical */
    }

    let db = useDashboardStore.getState().db;
    if (!db) {
      db = await initDuckDB();
      useDashboardStore.setState({ db: db as any });
    }

    useDashboardStore.setState(prev => ({
      ...prev,
      dataSourceStatus: {
        ...prev.dataSourceStatus,
        [dsId]: "loading" as const,
      },
    }));

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/consoles/${console_.id}/export?format=json&limit=500000`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(
          `Export failed: ${response.status} ${response.statusText}`,
        );
      }
      const json = await response.json();
      const rows = json.data || [];
      console.log(
        `[Dashboard] Loading JSON data for "${newDs.name}": ${rows.length} rows`,
      );
      const { loadJsonTable } = await import("../../lib/duckdb");
      await loadJsonTable(db, newDs.name, rows);
      console.log(`[Dashboard] Table "${newDs.name}" loaded successfully`);
      useDashboardStore.setState(prev => ({
        ...prev,
        dataSourceStatus: {
          ...prev.dataSourceStatus,
          [dsId]: "ready" as const,
        },
      }));
    } catch (err) {
      console.error(
        `[Dashboard] Failed to load data source "${newDs.name}":`,
        err,
      );
      useDashboardStore.setState(prev => ({
        ...prev,
        dataSourceStatus: {
          ...prev.dataSourceStatus,
          [dsId]: "error" as const,
        },
      }));
    }

    setSearchQuery("");
    setSearchResults([]);
    setAddingId(null);
  };

  const handleRemoveDataSource = async (dsId: string) => {
    const store = useDashboardStore.getState();
    const dashboard = store.activeDashboard;
    if (!dashboard || !workspaceId) return;

    setRemovingId(dsId);

    const removed = dashboard.dataSources.find(d => d.id === dsId);
    const updatedSources = dashboard.dataSources.filter(d => d.id !== dsId);

    useDashboardStore.setState(prev => ({
      ...prev,
      activeDashboard: prev.activeDashboard
        ? { ...prev.activeDashboard, dataSources: updatedSources }
        : prev.activeDashboard,
    }));

    try {
      await apiClient.patch(
        `/workspaces/${workspaceId}/dashboards/${dashboard._id}`,
        { dataSources: updatedSources },
      );
    } catch {
      /* non-critical */
    }

    if (removed && store.db) {
      try {
        await dropTable(store.db, removed.name);
      } catch {
        /* non-critical */
      }
    }

    setRemovingId(null);
  };

  const handleRefreshDataSource = async (dsId: string) => {
    if (!workspaceId) return;
    const ds = activeDashboard?.dataSources.find(d => d.id === dsId);
    if (ds) await loadDataSource(ds, workspaceId);
  };

  const dataSources = activeDashboard?.dataSources ?? [];

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
          Add Data Source
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
              const status = dataSourceStatus[ds.id];
              const chipProps = status ? STATUS_CHIP_PROPS[status] : null;

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
                  />
                  <ListItemSecondaryAction
                    sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                  >
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
                  useDashboardStore
                    .getState()
                    .refreshAllDataSources(workspaceId);
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
