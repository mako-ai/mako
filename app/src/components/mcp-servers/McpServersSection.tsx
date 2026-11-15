/**
 * Settings → MCP Servers management: add/edit MCP servers (Close preset or
 * any custom Streamable-HTTP server), save credentials, test the connection,
 * curate the exposed tool list, and review per-user approval grants.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  useMediaQuery,
  useTheme,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Search } from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  useMcpStore,
} from "../../store/mcpStore";
import {
  WRITE_SCOPE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  faviconForUrl,
  notifyMcp,
} from "./mcp-server-helpers";
import { ConnectionIcon } from "./ConnectionIcon";
import { AddServerDialog } from "./AddServerDialog";
import { ServerDetail } from "./ServerDetail";
import { ConnectionCard } from "./ConnectionCard";

export function McpServersSection() {
  const { currentWorkspace, loading: workspaceLoading } = useWorkspace();
  const muiTheme = useTheme();
  const fullScreenDialog = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const servers = useMcpStore(s => s.servers);
  const presets = useMcpStore(s => s.presets);
  const loading = useMcpStore(s => s.loading);
  const error = useMcpStore(s => s.error);
  const fetchServers = useMcpStore(s => s.fetchServers);
  const fetchPresets = useMcpStore(s => s.fetchPresets);
  const oauthReturn = useMcpStore(s => s.oauthReturn);
  const clearOAuthReturn = useMcpStore(s => s.clearOAuthReturn);
  const [addOpen, setAddOpen] = useState(false);
  const [addPreset, setAddPreset] = useState<string | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [autoDiscoverId, setAutoDiscoverId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const isAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  useEffect(() => {
    if (!workspaceLoading && currentWorkspace) {
      void fetchServers(currentWorkspace.id);
      void fetchPresets();
    }
  }, [workspaceLoading, currentWorkspace, fetchServers, fetchPresets]);

  // Plain snackbar messages; the severity only ever chose the wording.

  // Fallback capture for entry paths that skip UrlSync hydration — normally
  // UrlSync already moved the query flags into the store on page load.
  useEffect(() => {
    useMcpStore.getState().captureOAuthReturn();
  }, []);

  // Surface the OAuth callback outcome: reopen the server's modal and, on
  // success, auto-run discovery so tools load without another click.
  useEffect(() => {
    if (!oauthReturn) return;
    clearOAuthReturn();
    const { connected, error: oauthError, serverId } = oauthReturn;
    if (serverId) setDetailId(serverId);
    if (oauthError) {
      notifyMcp(`OAuth connection failed: ${oauthError}`, "error");
      return;
    }
    if (!connected) return;
    if (serverId) {
      setAutoDiscoverId(serverId);
      notifyMcp("Account connected — loading tools…", "success");
    } else {
      notifyMcp(
        "Account connected — test the connection to load tools",
        "success",
      );
    }
  }, [oauthReturn, clearOAuthReturn]);

  const effectivePresets: McpPresetInfo[] =
    presets.length > 0
      ? presets
      : [
          {
            type: "custom",
            label: "Custom MCP server",
            description: "Connect any MCP server over Streamable HTTP.",
            url: "",
            urlEditable: true,
            authType: "api_key",
            authOptions: ["api_key", "oauth", "none"],
            headerFields: [],
          },
        ];

  const presetByType = (type: string) =>
    effectivePresets.find(p => p.type === type);

  /** Icon for a configured server: preset logo, else the URL's favicon. */
  const serverIcon = (server: McpServerInfo) =>
    presetByType(server.connectorType)?.icon ??
    faviconForUrl(server.transport.url);

  const query = search.trim().toLowerCase();
  const matches = (...texts: Array<string | null | undefined>) =>
    !query || texts.some(t => t?.toLowerCase().includes(query));

  const visibleServers = servers.filter(s =>
    matches(s.name, s.description, s.transport.url),
  );
  // Preset cards: hide single-instance presets that are already configured
  // (custom stays — you can add any number of custom servers).
  const availablePresets = effectivePresets.filter(
    p =>
      matches(p.label, p.description) &&
      (p.type === "custom" || !servers.some(s => s.connectorType === p.type)),
  );

  const detailServer = servers.find(s => s.id === detailId) ?? null;

  return (
    <Box>
      <TextField
        size="small"
        fullWidth
        placeholder="Search connections and tools…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        sx={{ mb: 2.5 }}
        slotProps={{
          input: {
            startAdornment: (
              <Box
                sx={{
                  mr: 1,
                  display: "flex",
                  alignItems: "center",
                  color: "text.disabled",
                }}
              >
                <Search size={15} />
              </Box>
            ),
          },
        }}
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && servers.length === 0 ? (
        <CircularProgress size={22} />
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 1.5,
          }}
        >
          {visibleServers.map(server => {
            const needsAttention =
              server.status === "error" || server.status === "awaiting_auth";
            return (
              <ConnectionCard
                key={server.id}
                icon={<ConnectionIcon src={serverIcon(server)} />}
                title={server.name}
                description={
                  server.description ??
                  (server.connectorType !== "custom"
                    ? (presetByType(server.connectorType)?.description ??
                      server.transport.url)
                    : server.transport.url)
                }
                connected={server.status === "connected"}
                statusChip={
                  needsAttention ? (
                    <Chip
                      label={STATUS_LABELS[server.status]}
                      size="small"
                      color={STATUS_COLORS[server.status]}
                      variant="outlined"
                      sx={{ height: 20, fontSize: 10 }}
                    />
                  ) : undefined
                }
                actionLabel={
                  server.status === "connected" ? "Manage" : "Finish setup"
                }
                actionVariant={
                  server.status === "connected" ? "outlined" : "contained"
                }
                onAction={() => setDetailId(server.id)}
              />
            );
          })}
          {availablePresets.map(preset => (
            <ConnectionCard
              key={`preset-${preset.type}`}
              icon={<ConnectionIcon src={preset.icon} />}
              title={preset.label}
              description={preset.description}
              actionLabel="Connect"
              onAction={() => {
                setAddPreset(preset.type);
                setAddOpen(true);
              }}
              disabled={!isAdmin}
            />
          ))}
        </Box>
      )}
      {!isAdmin && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            display: "block",
            mt: 1.5,
          }}
        >
          Only workspace admins can add connections. You can connect your own
          account on per-user connections via Manage.
        </Typography>
      )}

      <AddServerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        presets={effectivePresets}
        initialPreset={addPreset}
        onCreated={serverId => {
          setDetailId(serverId);
          notifyMcp(
            "Connection added — finish setup to load its tools",
            "success",
          );
        }}
      />

      <Dialog
        open={detailServer !== null}
        onClose={() => setDetailId(null)}
        maxWidth="md"
        fullWidth
        fullScreen={fullScreenDialog}
      >
        {detailServer && (
          <>
            <DialogTitle>
              <Stack
                direction="row"
                spacing={1.5}
                useFlexGap
                sx={{
                  alignItems: "center",
                  flexWrap: "wrap",
                  rowGap: 0.5,
                }}
              >
                <ConnectionIcon src={serverIcon(detailServer)} size={28} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="subtitle1"
                    noWrap
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {detailServer.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    noWrap
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {detailServer.transport.url}
                  </Typography>
                </Box>
                <Chip
                  label={STATUS_LABELS[detailServer.status]}
                  size="small"
                  color={STATUS_COLORS[detailServer.status]}
                  variant="outlined"
                  sx={{ height: 20 }}
                />
                <Chip
                  label={WRITE_SCOPE_LABELS[detailServer.writeScope]}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20 }}
                />
              </Stack>
            </DialogTitle>
            <DialogContent dividers>
              <ServerDetail
                server={detailServer}
                preset={presetByType(detailServer.connectorType)}
                isAdmin={isAdmin}
                autoDiscover={autoDiscoverId === detailServer.id}
                onAutoDiscoverConsumed={() => setAutoDiscoverId(null)}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDetailId(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
