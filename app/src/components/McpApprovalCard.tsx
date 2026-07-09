/**
 * Human-in-the-loop approval card for MCP tool calls, modeled on Claude's
 * connector permission prompt in a compact, chat-panel-friendly layout:
 *
 *   [icon] Mako wants to use <tool> from <server>        [Destructive]
 *          { input preview }
 *          [ Always allow ⏎ | v ]  [ Deny esc ]
 *
 * "Always allow" persists a per-user grant for this tool. The overflow menu
 * also offers "Always allow all tools from <server>" (server-wide `*` grant).
 * Both are offered only when the workspace admin's restriction ceiling for
 * the tool permits Always allow — otherwise "Allow once ⏎" is primary.
 * Enter triggers the primary action, Escape denies.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from "@mui/material";
import {
  ChevronDown,
  CornerDownLeft,
  Plug,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useMcpStore } from "../store/mcpStore";
import { BUI_MONO_FONT_FAMILY } from "./chat/bui-styles";

/** Beautiful UI tint pill (green/red/neutral status badge). */
const Pill: React.FC<{
  tone: "green" | "red" | "neutral";
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ tone, icon, children }) => (
  <Box
    component="span"
    sx={{
      display: "inline-flex",
      alignItems: "center",
      gap: 0.5,
      px: 1,
      py: 0.25,
      borderRadius: "999px",
      fontSize: 11,
      fontWeight: 600,
      flexShrink: 0,
      ...(tone === "green"
        ? {
            backgroundColor: "var(--bui-green-tint)",
            color: "var(--bui-green)",
          }
        : tone === "red"
          ? { backgroundColor: "var(--bui-red-tint)", color: "var(--bui-red)" }
          : {
              backgroundColor: "var(--bui-field)",
              color: "var(--bui-ink-2)",
            }),
    }}
  >
    {icon}
    {children}
  </Box>
);

/** Sentinel matching api MCP_SERVER_WIDE_GRANT_TOOL. */
const SERVER_WIDE_GRANT = "*";

export interface McpApprovalResponseArgs {
  approvalId: string;
  approved: boolean;
}

interface McpApprovalCardProps {
  toolName: string;
  input?: unknown;
  approvalId: string;
  /**
   * Resolved display state:
   *  - "pending"  — waiting for the user's decision (buttons shown)
   *  - "approved" — user approved; execution continues
   *  - "denied"   — user denied
   */
  resolution: "pending" | "approved" | "denied";
  onRespond: (args: McpApprovalResponseArgs) => void;
}

function formatInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const json = JSON.stringify(input);
    if (json === "{}") return "";
    const pretty = JSON.stringify(input, null, 2);
    // Short inputs stay on one line; longer ones get the pretty layout.
    const text = json.length <= 72 ? json : pretty;
    return text.length > 400 ? text.slice(0, 400) + "\n…" : text;
  } catch {
    return String(input);
  }
}

function ServerIcon({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <Box
      sx={{
        width: 30,
        height: 30,
        borderRadius: "8px",
        boxShadow: "var(--bui-shadow-hairline)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bui-field)",
        color: "var(--bui-ink-2)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {src && !failed ? (
        <Box
          component="img"
          src={src}
          alt=""
          onError={() => setFailed(true)}
          sx={{ width: 20, height: 20, objectFit: "contain" }}
        />
      ) : (
        <Plug size={15} />
      )}
    </Box>
  );
}

export const McpApprovalCard: React.FC<McpApprovalCardProps> = ({
  toolName,
  input,
  approvalId,
  resolution,
  onRespond,
}) => {
  const { currentWorkspace } = useWorkspace();
  const toolInfo = useMcpStore(s => s.toolInfo[toolName]);
  const saveGrant = useMcpStore(s => s.saveGrant);
  const [busy, setBusy] = useState<"once" | "always" | "deny" | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const inputPreview = useMemo(() => formatInput(input), [input]);
  const displayName = toolInfo?.toolName ?? toolName;
  const serverName = toolInfo?.serverName;
  const isDestructive = toolInfo?.riskTier === "destructive";
  const canAlwaysAllow = toolInfo?.canAlwaysAllow ?? false;

  // Refresh tool metadata when a card goes pending: the cached copy may
  // predate an admin restriction change, and offering "Always allow" on a
  // tool whose ceiling is now "Ask" would mislead (the grant save is
  // rejected server-side, but the button shouldn't be shown at all).
  const pendingForInfo = resolution === "pending";
  useEffect(() => {
    if (pendingForInfo && currentWorkspace) {
      void useMcpStore.getState().fetchToolInfo(currentWorkspace.id);
    }
  }, [pendingForInfo, currentWorkspace]);

  const respond = async (
    approved: boolean,
    always: boolean,
    scope: "tool" | "server" = "tool",
  ) => {
    if (busyRef.current) return;
    setBusy(always ? "always" : approved ? "once" : "deny");
    setMenuAnchor(null);
    setGrantError(null);
    try {
      if (always && approved && currentWorkspace && toolInfo) {
        // Persist the grant first so the server-side needsApproval check
        // already sees it if the model calls this tool again in the same turn.
        await saveGrant(
          currentWorkspace.id,
          toolInfo.serverId,
          scope === "server" ? SERVER_WIDE_GRANT : toolInfo.toolName,
          "always_allow",
        );
      }
    } catch (error) {
      // Grant persistence failing shouldn't block the one-time approval, but
      // surface it — otherwise "Always allow" looks like it stuck when it didn't.
      if (always && approved) {
        setGrantError(
          error instanceof Error
            ? error.message
            : "Could not save Always allow — this call will still run once.",
        );
      }
    } finally {
      onRespond({ approvalId, approved });
      setBusy(null);
    }
  };

  const pending = resolution === "pending";
  const primaryIsAlways = pending && canAlwaysAllow;

  // Claude-style keyboard shortcuts: Enter = primary allow, Esc = deny.
  // Focus usually sits in the chat composer, so inputs are only exempted
  // while they actually contain text (Enter must keep sending a typed
  // message; an empty composer yields Enter to the approval card). Escape
  // always denies — it has no competing meaning while a card is pending.
  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (event.key === "Enter") {
        const inputText = isTextInput
          ? ((target as HTMLInputElement).value ?? target.textContent ?? "")
          : "";
        if (isTextInput && inputText.trim().length > 0) return;
        event.preventDefault();
        event.stopPropagation();
        void respond(true, primaryIsAlways, "tool");
      } else if (event.key === "Escape") {
        event.preventDefault();
        void respond(false, false);
      }
    };
    // Capture phase: beat the composer's own Enter handler for the
    // empty-composer case.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, primaryIsAlways, approvalId]);

  const statusChip = isDestructive ? (
    <Pill tone="red">Destructive</Pill>
  ) : resolution === "approved" ? (
    <Pill tone="green" icon={<ShieldCheck size={11} />}>
      Approved
    </Pill>
  ) : resolution === "denied" ? (
    <Pill tone="red" icon={<ShieldX size={11} />}>
      Denied
    </Pill>
  ) : null;

  // Destructive cards show the resolution chip too (both can apply).
  const secondChip =
    isDestructive && resolution !== "pending" ? (
      <Pill
        tone={resolution === "approved" ? "green" : "red"}
        icon={
          resolution === "approved" ? (
            <ShieldCheck size={11} />
          ) : (
            <ShieldX size={11} />
          )
        }
      >
        {resolution === "approved" ? "Approved" : "Denied"}
      </Pill>
    ) : null;

  return (
    <Box
      sx={{
        borderRadius: "14px",
        p: 1.25,
        my: 0.5,
        backgroundColor: "var(--bui-surface)",
        boxShadow:
          pending && isDestructive
            ? "0 0 0 1px var(--bui-red), 0 1px 2px oklch(0% 0 0 / 0.05), 0 2px 6px oklch(0% 0 0 / 0.04)"
            : "var(--bui-shadow-card)",
      }}
      data-testid="mcp-approval-card"
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <ServerIcon src={toolInfo?.serverIcon} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={0.75}
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
          >
            <Typography
              variant="body2"
              sx={{ fontWeight: 500, fontSize: 13, color: "var(--bui-ink)" }}
            >
              Mako wants to use{" "}
              <Box
                component="span"
                sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12.5 }}
              >
                {displayName}
              </Box>
              {serverName ? ` from ${serverName}` : ""}
            </Typography>
            {statusChip}
            {secondChip}
          </Stack>

          {pending && !canAlwaysAllow && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mt: 0.5 }}
            >
              Workspace policy requires approval each time for this tool.
            </Typography>
          )}

          {inputPreview && (
            <Box
              component="pre"
              sx={{
                m: 0,
                mt: 0.75,
                px: 1,
                py: 0.5,
                borderRadius: "8px",
                backgroundColor: "var(--bui-inset)",
                boxShadow: "var(--bui-shadow-hairline)",
                color: "var(--bui-ink-2)",
                fontSize: 11.5,
                fontFamily: BUI_MONO_FONT_FAMILY,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 96,
                overflow: "auto",
              }}
            >
              {inputPreview}
            </Box>
          )}

          {grantError && (
            <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
              {grantError}
            </Alert>
          )}

          {pending && (
            <Stack
              direction="row"
              spacing={1}
              sx={{ mt: 1, flexWrap: "wrap", rowGap: 1 }}
              useFlexGap
            >
              <ButtonGroup
                variant="contained"
                size="small"
                disableElevation
                sx={{
                  "& .MuiButton-root": {
                    backgroundColor: "var(--bui-ink)",
                    color: "var(--bui-surface)",
                    textTransform: "none",
                    fontSize: 12.5,
                    fontWeight: 500,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
                    "&:hover": { opacity: 0.85 },
                  },
                  "& .MuiButton-root:first-of-type": {
                    borderTopLeftRadius: 8,
                    borderBottomLeftRadius: 8,
                  },
                  "& .MuiButton-root:last-of-type": {
                    borderTopRightRadius: 8,
                    borderBottomRightRadius: 8,
                  },
                }}
              >
                <Button
                  disabled={busy !== null}
                  onClick={() => void respond(true, primaryIsAlways, "tool")}
                  startIcon={
                    busy === (primaryIsAlways ? "always" : "once") ? (
                      <CircularProgress size={12} color="inherit" />
                    ) : undefined
                  }
                  endIcon={
                    <CornerDownLeft size={12} style={{ opacity: 0.6 }} />
                  }
                  data-testid={
                    primaryIsAlways
                      ? "mcp-approval-always-allow"
                      : "mcp-approval-allow-once"
                  }
                >
                  {primaryIsAlways ? "Always allow this tool" : "Allow once"}
                </Button>
                {primaryIsAlways && (
                  <Button
                    sx={{ px: 0.5, minWidth: 28 }}
                    disabled={busy !== null}
                    onClick={e => setMenuAnchor(e.currentTarget)}
                    aria-label="More allow options"
                    data-testid="mcp-approval-more"
                  >
                    <ChevronDown size={13} />
                  </Button>
                )}
              </ButtonGroup>
              <Menu
                anchorEl={menuAnchor}
                open={menuAnchor !== null}
                onClose={() => setMenuAnchor(null)}
              >
                <MenuItem
                  dense
                  onClick={() => void respond(true, false)}
                  data-testid="mcp-approval-allow-once"
                >
                  Allow once
                </MenuItem>
                {canAlwaysAllow && serverName && (
                  <MenuItem
                    dense
                    onClick={() => void respond(true, true, "server")}
                    data-testid="mcp-approval-always-allow-server"
                  >
                    Always allow all tools from {serverName}
                  </MenuItem>
                )}
              </Menu>
              <Button
                size="small"
                disabled={busy !== null}
                onClick={() => void respond(false, false)}
                startIcon={
                  busy === "deny" ? <CircularProgress size={12} /> : undefined
                }
                sx={{
                  textTransform: "none",
                  fontSize: 12.5,
                  fontWeight: 500,
                  borderRadius: "8px",
                  color: "var(--bui-ink-2)",
                  backgroundColor: "var(--bui-surface)",
                  boxShadow: "var(--bui-shadow-btn)",
                  "&:hover": {
                    backgroundColor: "var(--bui-hover)",
                    color: "var(--bui-ink)",
                  },
                }}
                data-testid="mcp-approval-deny"
              >
                Deny
                <Box
                  component="span"
                  sx={{ ml: 0.75, fontSize: 10, color: "var(--bui-ink-3)" }}
                >
                  Esc
                </Box>
              </Button>
            </Stack>
          )}
        </Box>
      </Stack>
    </Box>
  );
};
