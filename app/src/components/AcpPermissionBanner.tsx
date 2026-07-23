import { Alert, Button, Stack, Typography } from "@mui/material";
import { acpProviderLabel } from "../lib/acp-provider-label";
import { useAcpStore } from "../store/acpStore";

function toolLabel(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const tc = toolCall as {
    title?: unknown;
    name?: unknown;
    kind?: unknown;
    _meta?: { claudeCode?: { toolName?: unknown } };
  };
  // Prefer Claude `_meta` when present; Codex often only has title/name/kind.
  const name =
    (typeof tc._meta?.claudeCode?.toolName === "string" &&
      tc._meta.claudeCode.toolName) ||
    (typeof tc.title === "string" && tc.title) ||
    (typeof tc.name === "string" && tc.name) ||
    (typeof tc.kind === "string" && tc.kind) ||
    "tool";
  const kind = typeof tc.kind === "string" && tc.kind !== name ? tc.kind : "";
  return kind ? `${name} (${kind})` : name;
}

/**
 * Human-in-the-loop Allow / Deny for Local Agent ACP permissions that were
 * not auto-approved (Bash, file edits, etc.). Shown in main Chat above the
 * composer — never send the user to a terminal to approve.
 */
export function AcpPermissionBanner() {
  const pending = useAcpStore(s => {
    const activeId = s.activeSessionId;
    const activePrompt = activeId ? s.permissionsBySession[activeId] : null;
    if (activeId && activePrompt) {
      return { sessionId: activeId, prompt: activePrompt };
    }
    for (const [sessionId, prompt] of Object.entries(s.permissionsBySession)) {
      if (prompt) return { sessionId, prompt };
    }
    return null;
  });
  const respondPermission = useAcpStore(s => s.respondPermission);
  const setActiveSession = useAcpStore(s => s.setActiveSession);
  const sessions = useAcpStore(s => s.sessions);
  const selectedProviderId = useAcpStore(s => s.selectedProviderId);
  const status = useAcpStore(s => s.status);

  if (!pending) return null;

  const { sessionId, prompt } = pending;
  const providerId =
    sessions.find(x => x.id === sessionId)?.providerId || selectedProviderId;
  const providerLabel = acpProviderLabel(providerId, status);

  return (
    <Alert
      severity="warning"
      sx={{
        mb: 1,
        alignItems: "flex-start",
        position: "sticky",
        bottom: 0,
        zIndex: 2,
      }}
      action={
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {prompt.options.map(opt => (
            <Button
              key={opt.optionId}
              size="small"
              color={
                opt.kind?.startsWith("reject") || opt.kind?.includes("deny")
                  ? "inherit"
                  : "warning"
              }
              variant={opt.kind?.startsWith("allow") ? "contained" : "outlined"}
              onClick={() => {
                setActiveSession(sessionId);
                void respondPermission(
                  opt.kind?.startsWith("reject") ? "cancelled" : "selected",
                  opt.kind?.startsWith("reject") ? undefined : opt.optionId,
                );
              }}
            >
              {opt.name}
            </Button>
          ))}
          <Button
            size="small"
            onClick={() => {
              setActiveSession(sessionId);
              void respondPermission("cancelled");
            }}
          >
            Deny
          </Button>
        </Stack>
      }
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Approval needed in Chat
      </Typography>
      <Typography variant="body2">
        {providerLabel} wants to run: {toolLabel(prompt.toolCall)}
      </Typography>
    </Alert>
  );
}
