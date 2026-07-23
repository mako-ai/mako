import { Alert, Button, Stack } from "@mui/material";
import { useAcpStore } from "../store/acpStore";

/**
 * Shows Allow / Deny for Local Agent ACP permissions that were not
 * auto-approved (e.g. Bash, file edits). Used in Coding Agents and main Chat.
 */
export function AcpPermissionBanner() {
  const activeSessionId = useAcpStore(s => s.activeSessionId);
  const prompt = useAcpStore(s =>
    activeSessionId ? s.permissionsBySession[activeSessionId] : null,
  );
  const respondPermission = useAcpStore(s => s.respondPermission);

  if (!prompt) return null;

  const tool = prompt.toolCall as { title?: string; kind?: string } | null;

  return (
    <Alert
      severity="warning"
      sx={{ mb: 1 }}
      action={
        <Stack direction="row" spacing={1}>
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
              onClick={() =>
                void respondPermission(
                  opt.kind?.startsWith("reject") ? "cancelled" : "selected",
                  opt.kind?.startsWith("reject") ? undefined : opt.optionId,
                )
              }
            >
              {opt.name}
            </Button>
          ))}
          <Button
            size="small"
            onClick={() => void respondPermission("cancelled")}
          >
            Deny
          </Button>
        </Stack>
      }
    >
      Permission required
      {tool?.title ? `: ${tool.title}` : ""}
      {tool?.kind ? ` (${tool.kind})` : ""}
    </Alert>
  );
}
