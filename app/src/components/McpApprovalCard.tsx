/**
 * Human-in-the-loop approval card for MCP tool calls, modeled on Claude's
 * connector permission prompt in a compact, chat-panel-friendly layout:
 *
 *   [icon] Mako wants to use <tool> from <server>        [Destructive]
 *          { input preview }
 *          [ Always allow ⏎ | v ]  [ Deny esc ]
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
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
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

  const statusChip = isDestructive ? (
    <Chip
      label="Destructive"
      size="small"
      color="error"
      variant="outlined"
      sx={{ height: 18, fontSize: 10 }}
    />
  ) : resolution === "approved" ? (
    <Chip
      icon={<ShieldCheck size={11} />}
      label="Approved"
      size="small"
      color="success"
      variant="outlined"
      sx={{ height: 18, fontSize: 10 }}
    />
  ) : resolution === "denied" ? (
    <Chip
      icon={<ShieldX size={11} />}
      label="Denied"
      size="small"
      color="error"
      variant="outlined"
      sx={{ height: 18, fontSize: 10 }}
    />
  ) : null;

  // Destructive cards show the resolution chip too (both can apply).
  const secondChip =
    isDestructive && resolution !== "pending" ? (
      <Chip
        icon={
          resolution === "approved" ? (
            <ShieldCheck size={11} />
          ) : (
            <ShieldX size={11} />
          )
        }
        label={resolution === "approved" ? "Approved" : "Denied"}
        size="small"
        color={resolution === "approved" ? "success" : "error"}
        variant="outlined"
        sx={{ height: 18, fontSize: 10 }}
      />
    ) : null;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: pending
          ? isDestructive
            ? "error.light"
            : "divider"
          : "divider",
        borderRadius: 2,
        p: 1.25,
        my: 0.5,
        bgcolor: "background.paper",
        boxShadow: pending ? "0 1px 6px rgba(0,0,0,0.06)" : "none",
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
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Mako wants to use{" "}
              <Box component="span" sx={{ fontFamily: "monospace" }}>
                {displayName}
              </Box>
              {serverName ? ` from ${serverName}` : ""}
            </Typography>
            {statusChip}
            {secondChip}
          </Stack>

          {inputPreview && (
            <Box
              component="pre"
              sx={{
                m: 0,
                mt: 0.75,
                px: 1,
                py: 0.5,
                borderRadius: 1,
                bgcolor: "action.hover",
                fontSize: 11.5,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 96,
                overflow: "auto",
              }}
            >
              {inputPreview}
            </Box>
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
                    bgcolor: "text.primary",
                    color: "background.paper",
                    textTransform: "none",
                    "&:hover": { bgcolor: "text.secondary" },
                  },
                }}
              >
                <Button
                  disabled={busy !== null}
                  onClick={() => void respond(true, primaryIsAlways)}
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
                  {primaryIsAlways ? "Always allow" : "Allow once"}
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
              </Menu>
              <Button
                variant="outlined"
                size="small"
                color="inherit"
                disabled={busy !== null}
                onClick={() => void respond(false, false)}
                startIcon={
                  busy === "deny" ? <CircularProgress size={12} /> : undefined
                }
                sx={{ textTransform: "none" }}
                data-testid="mcp-approval-deny"
              >
                Deny
                <Box
                  component="span"
                  sx={{ ml: 0.75, fontSize: 10, color: "text.disabled" }}
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
