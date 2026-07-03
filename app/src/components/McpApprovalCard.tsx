/**
 * Human-in-the-loop approval card for MCP tool calls, modeled on Claude's
 * connector permission prompt:
 *
 *   [server icon]
 *   Mako wants to use <tool> from <server>
 *   [ Always allow ⏎ | v ]   ← primary; dropdown holds "Allow once"
 *   [ Deny  Esc ]
 *
 * "Always allow" persists a per-user grant (each user decides only for
 * themselves) and is offered only when the workspace admin's restriction
 * ceiling for the tool permits it — otherwise "Allow once ⏎" is primary.
 * Enter triggers the primary action, Escape denies.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Chip,
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
    const json = JSON.stringify(input, null, 2);
    if (json === "{}") return "";
    return json.length > 600 ? json.slice(0, 600) + "\n…" : json;
  } catch {
    return String(input);
  }
}

function ServerIcon({ src }: { src?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <Box
      sx={{
        width: 52,
        height: 52,
        borderRadius: 2.5,
        border: 1,
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
        overflow: "hidden",
      }}
    >
      {src && !failed ? (
        <Box
          component="img"
          src={src}
          alt=""
          onError={() => setFailed(true)}
          sx={{ width: 32, height: 32, objectFit: "contain" }}
        />
      ) : (
        <Plug size={22} />
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

  const respond = async (approved: boolean, always: boolean) => {
    if (busyRef.current) return;
    setBusy(always ? "always" : approved ? "once" : "deny");
    setMenuAnchor(null);
    try {
      if (always && approved && currentWorkspace && toolInfo) {
        // Persist the grant first so the server-side needsApproval check
        // already sees it if the model calls this tool again in the same turn.
        await saveGrant(
          currentWorkspace.id,
          toolInfo.serverId,
          toolInfo.toolName,
          "always_allow",
        );
      }
    } catch {
      // Grant persistence failing shouldn't block the one-time approval.
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
        void respond(true, primaryIsAlways);
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

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 3,
        p: 2.5,
        my: 0.75,
        bgcolor: "background.paper",
        boxShadow: pending ? "0 2px 12px rgba(0,0,0,0.08)" : "none",
      }}
      data-testid="mcp-approval-card"
    >
      <Stack spacing={1.5} alignItems="center">
        <ServerIcon src={toolInfo?.serverIcon} />

        <Typography variant="body1" align="center" sx={{ fontWeight: 600 }}>
          Mako wants to use{" "}
          <Box component="span" sx={{ fontFamily: "monospace" }}>
            {displayName}
          </Box>
          {serverName ? ` from ${serverName}` : ""}
        </Typography>

        <Stack direction="row" spacing={1}>
          {isDestructive && (
            <Chip
              label="Destructive"
              size="small"
              color="error"
              variant="outlined"
              sx={{ height: 20 }}
            />
          )}
          {resolution === "approved" && (
            <Chip
              icon={<ShieldCheck size={13} />}
              label="Approved"
              size="small"
              color="success"
              variant="outlined"
              sx={{ height: 20 }}
            />
          )}
          {resolution === "denied" && (
            <Chip
              icon={<ShieldX size={13} />}
              label="Denied"
              size="small"
              color="error"
              variant="outlined"
              sx={{ height: 20 }}
            />
          )}
        </Stack>

        {inputPreview && (
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              fontSize: 12,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 160,
              overflow: "auto",
              width: "100%",
            }}
          >
            {inputPreview}
          </Box>
        )}

        {pending && (
          <Stack spacing={1} sx={{ width: "100%", maxWidth: 380 }}>
            <ButtonGroup
              variant="contained"
              fullWidth
              disableElevation
              sx={{
                "& .MuiButton-root": {
                  bgcolor: "text.primary",
                  color: "background.paper",
                  "&:hover": { bgcolor: "text.secondary" },
                },
              }}
            >
              <Button
                fullWidth
                disabled={busy !== null}
                onClick={() => void respond(true, primaryIsAlways)}
                startIcon={
                  busy === (primaryIsAlways ? "always" : "once") ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : undefined
                }
                endIcon={<CornerDownLeft size={13} style={{ opacity: 0.6 }} />}
                data-testid={
                  primaryIsAlways
                    ? "mcp-approval-always-allow"
                    : "mcp-approval-allow-once"
                }
              >
                {primaryIsAlways ? "Always allow" : "Allow once"}
              </Button>
              {primaryIsAlways && (
                <Button
                  size="small"
                  sx={{ width: 44, flex: "0 0 auto" }}
                  disabled={busy !== null}
                  onClick={e => setMenuAnchor(e.currentTarget)}
                  aria-label="More allow options"
                  data-testid="mcp-approval-more"
                >
                  <ChevronDown size={15} />
                </Button>
              )}
            </ButtonGroup>
            <Menu
              anchorEl={menuAnchor}
              open={menuAnchor !== null}
              onClose={() => setMenuAnchor(null)}
            >
              <MenuItem
                onClick={() => void respond(true, false)}
                data-testid="mcp-approval-allow-once"
              >
                Allow once
              </MenuItem>
            </Menu>
            <Button
              variant="outlined"
              fullWidth
              color="inherit"
              disabled={busy !== null}
              onClick={() => void respond(false, false)}
              startIcon={
                busy === "deny" ? <CircularProgress size={14} /> : undefined
              }
              data-testid="mcp-approval-deny"
            >
              Deny
              <Box
                component="span"
                sx={{ ml: 1, fontSize: 11, color: "text.disabled" }}
              >
                Esc
              </Box>
            </Button>
          </Stack>
        )}
      </Stack>
    </Box>
  );
};
