/**
 * Human-in-the-loop approval card for MCP tool calls (Claude-style).
 *
 * Rendered when a tool part enters the `approval-requested` state. Offers
 * Deny / Allow once / Always allow. "Always allow" persists a per-user grant
 * via the MCP store before approving, so future calls run without prompting.
 * Destructive-tier tools only offer Allow once unless the workspace admin
 * unlocked grants for the server.
 */
import React, { useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
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
    return json.length > 800 ? json.slice(0, 800) + "\n…" : json;
  } catch {
    return String(input);
  }
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

  const inputPreview = useMemo(() => formatInput(input), [input]);
  const displayName = toolInfo?.toolName ?? toolName;
  const serverName = toolInfo?.serverName;
  const isDestructive = toolInfo?.riskTier === "destructive";
  const canAlwaysAllow = toolInfo?.canAlwaysAllow ?? false;

  const respond = async (approved: boolean, always: boolean) => {
    setBusy(always ? "always" : approved ? "once" : "deny");
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

  return (
    <Box
      sx={{
        border: 1,
        borderColor: pending
          ? isDestructive
            ? "error.main"
            : "warning.main"
          : "divider",
        borderRadius: 2,
        p: 1.5,
        my: 0.5,
        bgcolor: "background.paper",
      }}
      data-testid="mcp-approval-card"
    >
      <Stack direction="row" spacing={1} alignItems="center">
        {resolution === "approved" ? (
          <ShieldCheck size={15} />
        ) : resolution === "denied" ? (
          <ShieldX size={15} />
        ) : (
          <ShieldAlert size={15} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" fontWeight={600} noWrap>
            {pending ? "Approval required: " : ""}
            <Box component="span" sx={{ fontFamily: "monospace" }}>
              {displayName}
            </Box>
            {serverName ? ` on ${serverName}` : ""}
          </Typography>
        </Box>
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
            label="Approved"
            size="small"
            color="success"
            variant="outlined"
            sx={{ height: 20 }}
          />
        )}
        {resolution === "denied" && (
          <Chip
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
            mt: 1,
            p: 1,
            borderRadius: 1,
            bgcolor: "action.hover",
            fontSize: 12,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 180,
            overflow: "auto",
          }}
        >
          {inputPreview}
        </Box>
      )}

      {pending && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button
            size="small"
            variant="outlined"
            color="error"
            disabled={busy !== null}
            startIcon={
              busy === "deny" ? <CircularProgress size={12} /> : undefined
            }
            onClick={() => void respond(false, false)}
            data-testid="mcp-approval-deny"
          >
            Deny
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={busy !== null}
            startIcon={
              busy === "once" ? (
                <CircularProgress size={12} color="inherit" />
              ) : undefined
            }
            onClick={() => void respond(true, false)}
            data-testid="mcp-approval-allow-once"
          >
            Allow once
          </Button>
          {canAlwaysAllow && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy !== null}
              startIcon={
                busy === "always" ? <CircularProgress size={12} /> : undefined
              }
              onClick={() => void respond(true, true)}
              data-testid="mcp-approval-always-allow"
            >
              Always allow
            </Button>
          )}
        </Stack>
      )}
    </Box>
  );
};
