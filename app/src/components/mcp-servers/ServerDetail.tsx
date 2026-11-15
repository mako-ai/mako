import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { RefreshCw, Trash2 } from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  type McpToolRestriction,
  useMcpStore,
} from "../../store/mcpStore";
import { useConfirm } from "../ConfirmDialog";
import { RestrictionControl } from "./RestrictionControl";
import { OAuthClientForm } from "./OAuthClientForm";
import { OAuthConnectSection } from "./OAuthConnectSection";
import { CredentialsForm } from "./CredentialsForm";
import { ServerDetailsForm } from "./ServerDetailsForm";
import { notifyMcp } from "./mcp-server-helpers";

export function ServerDetail({
  server,
  preset,
  isAdmin,
  autoDiscover,
  onAutoDiscoverConsumed,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  isAdmin: boolean;
  /** Run discovery automatically on mount (set after an OAuth return). */
  autoDiscover?: boolean;
  onAutoDiscoverConsumed?: () => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const testServer = useMcpStore(s => s.testServer);
  const updateServer = useMcpStore(s => s.updateServer);
  const deleteServer = useMcpStore(s => s.deleteServer);
  const fetchGrants = useMcpStore(s => s.fetchGrants);
  const revokeGrant = useMcpStore(s => s.revokeGrant);
  const saveGrant = useMcpStore(s => s.saveGrant);
  const grants = useMcpStore(s => s.grants);
  const [testing, setTesting] = useState(false);
  const myGrants = grants[server.id] ?? [];
  const hasAvailableTools =
    server.status === "connected" && server.cachedTools.length > 0;
  const readTools = useMemo(
    () => server.cachedTools.filter(t => t.riskTier === "read"),
    [server.cachedTools],
  );
  const writeTools = useMemo(
    () => server.cachedTools.filter(t => t.riskTier !== "read"),
    [server.cachedTools],
  );

  useEffect(() => {
    if (currentWorkspace) {
      void fetchGrants(currentWorkspace.id, server.id);
    }
  }, [currentWorkspace, server.id, fetchGrants]);

  const handleTest = async () => {
    if (!currentWorkspace) return;
    setTesting(true);
    const result = await testServer(currentWorkspace.id, server.id);
    setTesting(false);
    notifyMcp(
      result.ok
        ? "Connected — tool list refreshed"
        : (result.error ?? "Connection failed"),
      result.ok ? "success" : "error",
    );
  };

  // After an OAuth return, kick off discovery without the extra click. The
  // ref guards StrictMode double-invocation; the parent clears the flag so
  // reopening the modal later doesn't re-trigger.
  const autoDiscoverRan = useRef(false);
  useEffect(() => {
    if (!autoDiscover || autoDiscoverRan.current || !currentWorkspace) return;
    autoDiscoverRan.current = true;
    onAutoDiscoverConsumed?.();
    void handleTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDiscover, currentWorkspace]);

  const handleSetRestriction = async (
    toolName: string,
    value: McpToolRestriction,
  ) => {
    if (!currentWorkspace) return;
    await updateServer(currentWorkspace.id, server.id, {
      toolPolicy: {
        restrictions: {
          ...server.toolPolicy.restrictions,
          [toolName]: value,
        },
      },
    });
  };

  const handleSetDefaultRestriction = async (value: McpToolRestriction) => {
    if (!currentWorkspace) return;
    await updateServer(currentWorkspace.id, server.id, {
      toolPolicy: { defaultRestriction: value },
    });
  };

  /**
   * The user's own permission (Claude-style): Always allow / Ask / Block,
   * stored as a grant ("Ask" simply clears it — the tool prompts on next
   * use). `toolName` may be `"*"` for a server-wide grant. Capped by the
   * admin ceiling via disabled options.
   */
  const handleSetUserPermission = async (
    toolName: string,
    value: "always_allow" | "ask" | "block",
    grantId?: string,
  ) => {
    if (!currentWorkspace) return;
    try {
      if (value === "ask") {
        if (grantId) {
          await revokeGrant(currentWorkspace.id, server.id, grantId);
        }
        return;
      }
      await saveGrant(
        currentWorkspace.id,
        server.id,
        toolName,
        value === "always_allow" ? "always_allow" : "always_deny",
      );
    } catch (error) {
      notifyMcp(
        error instanceof Error ? error.message : "Failed to update permission",
        "error",
      );
    }
  };

  const serverWideGrant = myGrants.find(g => g.toolName === "*");
  const serverWideValue =
    serverWideGrant?.decision === "always_allow"
      ? "always_allow"
      : serverWideGrant?.decision === "always_deny"
        ? "block"
        : "ask";
  const canServerWideAlwaysAllow = server.cachedTools.some(
    t => t.restriction === "always",
  );

  const handleDelete = async () => {
    if (!currentWorkspace) return;
    if (
      !(await confirm({
        title: `Remove "${server.name}"?`,
        body: "Stored credentials and grants are deleted too.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    ) {
      return;
    }
    await deleteServer(currentWorkspace.id, server.id);
    notifyMcp("Server removed", "success");
  };

  return (
    <Stack spacing={2.5}>
      {server.status === "error" && server.lastError && (
        <Alert severity="error">{server.lastError}</Alert>
      )}

      {isAdmin && (
        <>
          <ServerDetailsForm server={server} />
          <Divider />
        </>
      )}

      {server.authType === "oauth" ? (
        <>
          {/* The OAuth app form only appears when there's no deployment-wide
              client — with a shared app configured, connect is one click. */}
          {isAdmin &&
            preset?.oauth?.clientMode === "manual" &&
            server.oauthClientSource !== "environment" && (
              <>
                <OAuthClientForm server={server} preset={preset} />
                <Divider />
              </>
            )}
          <OAuthConnectSection
            server={server}
            preset={preset}
            onAlreadyAuthorized={() => void handleTest()}
          />
        </>
      ) : server.authType === "api_key" ? (
        <CredentialsForm
          server={server}
          preset={preset}
          onSaved={() => notifyMcp("Credentials saved", "success")}
        />
      ) : null}

      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
        }}
      >
        <Button
          variant="contained"
          size="small"
          startIcon={
            testing ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <RefreshCw size={14} />
            )
          }
          disabled={testing}
          onClick={handleTest}
        >
          {server.status === "connected" ? "Refresh tools" : "Test connection"}
        </Button>
        {isAdmin && (
          <Button
            size="small"
            color="error"
            startIcon={<Trash2 size={14} />}
            onClick={handleDelete}
          >
            Remove
          </Button>
        )}
      </Stack>

      {hasAvailableTools && (
        <>
          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Tool permission restrictions ({server.cachedTools.length})
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                display: "block",
                mb: 1.5,
              }}
            >
              Restrict which permission levels members can choose for each tool.
              Restrictions set a ceiling — users can always choose a stricter
              setting.
            </Typography>

            {isAdmin && (
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{
                  alignItems: "center",
                  mb: 1.5,
                  px: 1,
                  flexWrap: "wrap",
                  rowGap: 0.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">
                    Default restriction for unconfigured tools
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Applies to tools without a specific restriction below,
                    including tools this server adds later.
                  </Typography>
                </Box>
                <RestrictionControl
                  value={server.toolPolicy.defaultRestriction}
                  usesDefault={false}
                  disabled={!isAdmin}
                  onChange={value => void handleSetDefaultRestriction(value)}
                />
              </Stack>
            )}

            {(
              [
                ["Read-only tools", readTools],
                ["Write/delete tools", writeTools],
              ] as const
            ).map(([groupLabel, tools]) =>
              tools.length === 0 ? null : (
                <Box key={groupLabel} sx={{ mb: 1.5 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      color: "text.secondary",
                      display: "block",
                      mb: 0.5,
                      px: 1,
                    }}
                  >
                    {groupLabel} ({tools.length})
                  </Typography>
                  <Stack spacing={0.25}>
                    {tools.map(tool => {
                      const explicit =
                        server.toolPolicy.restrictions[tool.name];
                      return (
                        <Stack
                          key={tool.name}
                          direction="row"
                          spacing={1}
                          useFlexGap
                          sx={{
                            alignItems: "center",
                            py: 0.5,
                            px: 1,
                            borderRadius: 1,
                            flexWrap: "wrap",
                            rowGap: 0.5,
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                        >
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Stack
                              direction="row"
                              spacing={1}
                              sx={{
                                alignItems: "center",
                              }}
                            >
                              <Typography
                                variant="body2"
                                sx={{ fontFamily: "monospace" }}
                                noWrap
                              >
                                {tool.name}
                              </Typography>
                              {tool.riskTier === "destructive" && (
                                <Chip
                                  label="Destructive"
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  sx={{ height: 16, fontSize: 10 }}
                                />
                              )}
                            </Stack>
                            <Typography
                              variant="caption"
                              noWrap
                              sx={{
                                color: "text.secondary",
                                display: "block",
                              }}
                            >
                              {tool.description ?? ""} Users can choose:{" "}
                              {tool.restriction === "always"
                                ? "Always allow, Ask, or Block"
                                : tool.restriction === "ask"
                                  ? "Ask or Block"
                                  : "Blocked"}
                            </Typography>
                          </Box>
                          {!explicit && (
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.disabled",
                                whiteSpace: "nowrap",
                              }}
                            >
                              Uses default
                            </Typography>
                          )}
                          <RestrictionControl
                            value={tool.restriction}
                            usesDefault={!explicit}
                            disabled={!isAdmin}
                            onChange={value =>
                              void handleSetRestriction(tool.name, value)
                            }
                          />
                        </Stack>
                      );
                    })}
                  </Stack>
                </Box>
              ),
            )}
          </Box>
        </>
      )}

      {hasAvailableTools && (
        <>
          <Divider />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Your tool permissions
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                display: "block",
                mb: 1,
              }}
            >
              These choices apply only to you. Read tools run without prompting.
              Write tools ask until you Always allow — per tool below, or for
              the whole server.
            </Typography>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{
                alignItems: "center",
                mb: 1,
                py: 0.75,
                px: 1,
                borderRadius: 1,
                bgcolor: "action.hover",
                flexWrap: "wrap",
                rowGap: 0.5,
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  All tools on {server.name}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Server-wide Always allow covers every tool the admin still
                  permits. Per-tool Block below overrides it. Destructive tools
                  stay Ask unless an admin unlocks them.
                </Typography>
              </Box>
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <Select
                  value={serverWideValue}
                  disabled={!currentWorkspace}
                  onChange={e =>
                    void handleSetUserPermission(
                      "*",
                      e.target.value as "always_allow" | "ask" | "block",
                      serverWideGrant?.id,
                    )
                  }
                  sx={{ fontSize: 13 }}
                >
                  <MenuItem
                    value="always_allow"
                    disabled={!canServerWideAlwaysAllow}
                  >
                    Always allow
                  </MenuItem>
                  <MenuItem value="ask">Ask (default)</MenuItem>
                  <MenuItem value="block">Block all</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <Stack spacing={0.25}>
              {server.cachedTools.map(tool => {
                const grant = myGrants.find(g => g.toolName === tool.name);
                const value =
                  grant?.decision === "always_allow"
                    ? "always_allow"
                    : grant?.decision === "always_deny"
                      ? "block"
                      : "ask";
                const blockedByAdmin = tool.restriction === "block";
                const inheritedAlways =
                  !grant &&
                  serverWideGrant?.decision === "always_allow" &&
                  tool.restriction === "always" &&
                  tool.riskTier !== "read";
                const ceilingOverridesGrant =
                  grant?.decision === "always_allow" &&
                  tool.restriction === "ask";
                return (
                  <Stack
                    key={tool.name}
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{
                      alignItems: "center",
                      py: 0.5,
                      px: 1,
                      borderRadius: 1,
                      flexWrap: "wrap",
                      rowGap: 0.5,
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: "monospace" }}
                        noWrap
                      >
                        {tool.name}
                      </Typography>
                      {tool.riskTier === "read" && value === "ask" && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                          }}
                        >
                          Read — runs without prompting
                        </Typography>
                      )}
                      {inheritedAlways && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                          }}
                        >
                          Covered by server-wide Always allow
                        </Typography>
                      )}
                      {ceilingOverridesGrant && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "warning.main",
                          }}
                        >
                          Always allow saved, but admin Ask still prompts
                        </Typography>
                      )}
                    </Box>
                    {blockedByAdmin ? (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.disabled",
                        }}
                      >
                        Blocked by admin
                      </Typography>
                    ) : (
                      <FormControl size="small" sx={{ minWidth: 140 }}>
                        <Select
                          value={value}
                          disabled={!currentWorkspace}
                          onChange={e =>
                            void handleSetUserPermission(
                              tool.name,
                              e.target.value as
                                "always_allow" | "ask" | "block",
                              grant?.id,
                            )
                          }
                          sx={{ fontSize: 13 }}
                        >
                          <MenuItem
                            value="always_allow"
                            disabled={tool.restriction !== "always"}
                          >
                            Always allow
                          </MenuItem>
                          <MenuItem value="ask">Ask</MenuItem>
                          <MenuItem value="block">Block</MenuItem>
                        </Select>
                      </FormControl>
                    )}
                  </Stack>
                );
              })}
            </Stack>
          </Box>
        </>
      )}
    </Stack>
  );
}
