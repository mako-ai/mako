import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  MenuItem,
  Radio,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Refresh as RefreshIcon } from "@mui/icons-material";
import SettingsLayout from "./SettingsLayout";
import { useWorkspace } from "../../contexts/workspace-context";

interface AdminCuratedModel {
  id: string;
  provider: string;
  name: string;
  description: string;
  contextWindow: number | null;
  blendedCostPerM: number | null;
  visible: boolean;
  tier: "free" | "pro";
}

interface AdminCatalogResponse {
  models: AdminCuratedModel[];
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
  utilityModelId: string | null;
  gatewayFetchedAt: string | null;
  curationUpdatedAt: string | null;
  lastRefreshError: string | null;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

interface FlaggedWorkspace {
  id: string;
  name: string;
  slug: string;
  appsV2Enabled: boolean;
}

/** Per-workspace rollout switches. Apps v2 is the first; add rows as flags appear. */
function FeatureFlagsCard() {
  const { refreshWorkspaces } = useWorkspace();
  const [rows, setRows] = useState<FlaggedWorkspace[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Thousands of workspaces: search, and show the flagged ones first so the
  // rollout set is always visible without scrolling.
  const [query, setQuery] = useState("");
  const LIMIT = 50;
  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const matches = q
      ? rows.filter(
          r =>
            r.name.toLowerCase().includes(q) ||
            r.slug.toLowerCase().includes(q) ||
            r.id === q,
        )
      : rows;
    return [...matches]
      .sort((a, b) => Number(b.appsV2Enabled) - Number(a.appsV2Enabled))
      .slice(0, LIMIT);
  }, [rows, query]);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ workspaces: FlaggedWorkspace[] }>(
        "/api/admin/workspaces/features",
      );
      setRows(data.workspaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load workspaces");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const flip = useCallback(
    async (row: FlaggedWorkspace, appsV2Enabled: boolean) => {
      setBusy(row.id);
      setError(null);
      try {
        await apiJson(`/api/admin/workspaces/${row.id}/features`, {
          method: "PATCH",
          body: JSON.stringify({ appsV2Enabled }),
        });
        setRows(
          prev =>
            prev?.map(r => (r.id === row.id ? { ...r, appsV2Enabled } : r)) ??
            prev,
        );
        // The rail reads the flag from the loaded workspace object; refresh
        // it so the icons follow without a reload.
        void refreshWorkspaces();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update");
      } finally {
        setBusy(null);
      }
    },
    [refreshWorkspaces],
  );

  return (
    <Card variant="outlined" sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Feature flags
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Per-workspace rollout. <strong>Apps v2</strong> turns on the
          git-backed apps, the sandbox and Source Control for a workspace; off,
          none of it is visible there.
        </Typography>
        {error && (
          <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {!rows ? (
          <CircularProgress size={18} />
        ) : (
          <TableContainer>
            <TextField
              size="small"
              fullWidth
              placeholder={`Search ${rows.length} workspaces by name, slug or id…`}
              value={query}
              onChange={e => setQuery(e.target.value)}
              sx={{ mb: 1 }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 0.5 }}
            >
              {rows.filter(r => r.appsV2Enabled).length} enabled · showing{" "}
              {visible.length}
              {visible.length === LIMIT ? ` of the first ${LIMIT} matches` : ""}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Workspace</TableCell>
                  <TableCell>Slug</TableCell>
                  <TableCell align="right">Apps v2</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(row => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.name}</TableCell>
                    <TableCell sx={{ color: "text.secondary" }}>
                      /{row.slug}
                    </TableCell>
                    <TableCell align="right">
                      <Switch
                        size="small"
                        checked={row.appsV2Enabled}
                        disabled={busy === row.id}
                        onChange={e => void flip(row, e.target.checked)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsAdmin() {
  const [data, setData] = useState<AdminCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hardRefreshing, setHardRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiJson<AdminCatalogResponse>("/api/admin/catalog");
      setData(res);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshNotice(null);
    try {
      const res = await apiJson<{
        success: boolean;
        refreshed?: { models: number; pricedModels: number };
        error?: string;
      }>("/api/admin/catalog/refresh", { method: "POST" });
      if (!res.success) {
        setRefreshError(res.error ?? "Unknown error");
      } else if (res.refreshed) {
        setRefreshNotice(
          `Refreshed catalog (${res.refreshed.models} models, ${res.refreshed.pricedModels} priced)`,
        );
      }
      await loadCatalog();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const handleHardRefresh = async () => {
    setHardRefreshing(true);
    setRefreshError(null);
    setRefreshNotice(null);
    try {
      const res = await apiJson<{
        success: boolean;
        refreshed?: {
          models: number;
          pricedModels: number;
          droppedEntries?: number;
        };
        error?: string;
      }>("/api/admin/catalog/hard-refresh", { method: "POST" });
      if (!res.success) {
        setRefreshError(res.error ?? "Unknown error");
      } else if (res.refreshed) {
        const dropped = res.refreshed.droppedEntries ?? 0;
        setRefreshNotice(
          `Hard refresh complete (${res.refreshed.models} models, ${res.refreshed.pricedModels} priced${
            dropped ? `, ${dropped} invalid rows skipped` : ""
          })`,
        );
      }
      await loadCatalog();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setHardRefreshing(false);
    }
  };

  const updateModel = async (
    modelId: string,
    patch: Partial<Pick<AdminCuratedModel, "visible" | "tier">>,
  ) => {
    if (!data) return;
    const existing = data.models.find(m => m.id === modelId);
    if (!existing) return;
    setSavingRowId(modelId);
    const optimistic: AdminCuratedModel = { ...existing, ...patch };
    setData({
      ...data,
      models: data.models.map(m => (m.id === modelId ? optimistic : m)),
    });
    try {
      await apiJson(
        `/api/admin/catalog/models/${encodeURIComponent(modelId)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            visible: optimistic.visible,
            tier: optimistic.tier,
          }),
        },
      );
    } catch (err) {
      await loadCatalog();
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRowId(null);
    }
  };

  const updateDefaults = async (patch: {
    defaultChatModelId?: string | null;
    defaultFreeChatModelId?: string | null;
    utilityModelId?: string | null;
  }) => {
    if (!data) return;
    setSavingDefaults(true);
    const next: AdminCatalogResponse = {
      ...data,
      defaultChatModelId:
        patch.defaultChatModelId !== undefined
          ? patch.defaultChatModelId
          : data.defaultChatModelId,
      defaultFreeChatModelId:
        patch.defaultFreeChatModelId !== undefined
          ? patch.defaultFreeChatModelId
          : data.defaultFreeChatModelId,
      utilityModelId:
        patch.utilityModelId !== undefined
          ? patch.utilityModelId
          : data.utilityModelId,
    };
    setData(next);
    try {
      await apiJson("/api/admin/catalog/defaults", {
        method: "PUT",
        body: JSON.stringify({
          defaultChatModelId: next.defaultChatModelId,
          defaultFreeChatModelId: next.defaultFreeChatModelId,
          utilityModelId: next.utilityModelId,
        }),
      });
    } catch (err) {
      await loadCatalog();
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDefaults(false);
    }
  };

  const filteredModels = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.models;
    return data.models.filter(
      m =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [data, search]);

  return (
    <SettingsLayout
      title="Super Admin"
      description="Cross-workspace controls. Curate which AI models are offered to every workspace, and pick the platform defaults for free and paid tiers."
      maxWidth="full"
    >
      <FeatureFlagsCard />
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              mb: 1,
            }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Refresh catalog
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                disableElevation
                startIcon={
                  refreshing ? <CircularProgress size={14} /> : <RefreshIcon />
                }
                onClick={handleRefresh}
                disabled={refreshing || hardRefreshing}
              >
                Refresh from AI Gateway
              </Button>
              <Tooltip title="Bypasses per-row validation (skips only malformed models) and clears all gateway caches. Use when new models aren't appearing.">
                <span>
                  <Button
                    variant="outlined"
                    color="warning"
                    size="small"
                    startIcon={
                      hardRefreshing ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : (
                        <RefreshIcon />
                      )
                    }
                    onClick={handleHardRefresh}
                    disabled={refreshing || hardRefreshing}
                  >
                    Hard refresh
                  </Button>
                </span>
              </Tooltip>
            </Box>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Pulls the latest model list + pricing from the Vercel AI Gateway.
            Any validation errors are shown below. <strong>Hard refresh</strong>{" "}
            validates each model row independently — dropping only malformed
            rows instead of skipping the whole snapshot — and clears every
            gateway cache, so use it when new models aren&apos;t showing up.
          </Typography>
          {data?.gatewayFetchedAt && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 1, display: "block" }}
            >
              Gateway snapshot:{" "}
              {new Date(data.gatewayFetchedAt).toLocaleString()}
            </Typography>
          )}
          {data?.curationUpdatedAt && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block" }}
            >
              Curation updated:{" "}
              {new Date(data.curationUpdatedAt).toLocaleString()}
            </Typography>
          )}
          {refreshError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {refreshError}
            </Alert>
          )}
          {!refreshError && data?.lastRefreshError && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Previous refresh reported: {data.lastRefreshError}
            </Alert>
          )}
          {refreshNotice && (
            <Alert severity="success" sx={{ mt: 2 }}>
              {refreshNotice}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            Curated models
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Toggle visibility per model and assign each one to a tier.
            Workspaces on the free plan only see models assigned to the free
            tier. The <strong>Fast</strong> model powers cheap utility tasks
            (version/commit messages, chat titles, descriptions); leave it unset
            to auto-pick the cheapest tool-use model.
          </Typography>

          {loadError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {loadError}
            </Alert>
          )}

          <TextField
            size="small"
            placeholder="Search models..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            fullWidth
            sx={{ mb: 2 }}
          />

          {loading ? (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Loading catalog...
              </Typography>
            </Box>
          ) : (
            <TableContainer
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                width: "100%",
              }}
            >
              <Table
                size="small"
                sx={{
                  tableLayout: "fixed",
                  width: "100%",
                  "& .MuiTableCell-root": {
                    py: 0.5,
                    px: 1,
                    fontSize: "0.8125rem",
                  },
                }}
              >
                <TableHead>
                  <TableRow>
                    <TableCell>Model</TableCell>
                    <TableCell sx={{ width: 120 }}>Provider</TableCell>
                    <TableCell align="right" sx={{ width: 90 }}>
                      $/M
                    </TableCell>
                    <TableCell align="center" sx={{ width: 70 }}>
                      Visible
                    </TableCell>
                    <TableCell sx={{ width: 90 }}>Tier</TableCell>
                    <TableCell align="center" sx={{ width: 80 }}>
                      Default&nbsp;paid
                    </TableCell>
                    <TableCell align="center" sx={{ width: 80 }}>
                      Default&nbsp;free
                    </TableCell>
                    <TableCell align="center" sx={{ width: 70 }}>
                      Fast
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredModels.map(m => (
                    <TableRow key={m.id} hover>
                      <TableCell>
                        <Typography variant="body2" noWrap>
                          {m.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          sx={{ display: "block" }}
                        >
                          {m.id}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" noWrap>
                          {m.provider}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {m.blendedCostPerM !== null
                          ? `$${m.blendedCostPerM.toFixed(2)}`
                          : "—"}
                      </TableCell>
                      <TableCell align="center">
                        <Switch
                          size="small"
                          checked={m.visible}
                          onChange={e =>
                            updateModel(m.id, { visible: e.target.checked })
                          }
                          disabled={savingRowId === m.id}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          size="small"
                          value={m.tier}
                          onChange={e =>
                            updateModel(m.id, {
                              tier: e.target.value as "free" | "pro",
                            })
                          }
                          disabled={savingRowId === m.id}
                          sx={{
                            width: "100%",
                            ".MuiSelect-select": {
                              py: 0.5,
                              fontSize: "0.8125rem",
                            },
                          }}
                        >
                          <MenuItem value="free">free</MenuItem>
                          <MenuItem value="pro">pro</MenuItem>
                        </Select>
                      </TableCell>
                      <TableCell align="center">
                        <Radio
                          size="small"
                          checked={data?.defaultChatModelId === m.id}
                          onChange={() =>
                            updateDefaults({ defaultChatModelId: m.id })
                          }
                          disabled={!m.visible || savingDefaults}
                          sx={{ p: 0.5 }}
                        />
                      </TableCell>
                      <TableCell align="center">
                        <Radio
                          size="small"
                          checked={data?.defaultFreeChatModelId === m.id}
                          onChange={() =>
                            updateDefaults({ defaultFreeChatModelId: m.id })
                          }
                          disabled={
                            !m.visible || m.tier !== "free" || savingDefaults
                          }
                          sx={{ p: 0.5 }}
                        />
                      </TableCell>
                      <TableCell align="center">
                        <Radio
                          size="small"
                          checked={data?.utilityModelId === m.id}
                          onChange={() =>
                            updateDefaults({
                              utilityModelId:
                                data?.utilityModelId === m.id ? null : m.id,
                            })
                          }
                          disabled={!m.visible || savingDefaults}
                          sx={{ p: 0.5 }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredModels.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={8} align="center">
                        <Typography variant="body2" color="text.secondary">
                          No models match the current filter.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
            Cross-workspace insights
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Workspace activity, usage leaderboards, and other platform-wide
            stats will land here.
          </Typography>
        </CardContent>
      </Card>
    </SettingsLayout>
  );
}
