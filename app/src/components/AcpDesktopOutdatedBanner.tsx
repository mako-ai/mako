import { Alert, Link, Typography } from "@mui/material";
import {
  ACP_REQUIRED_DESKTOP_VERSION,
  acpDesktopOutdatedSummary,
  acpIsDesktopOutdatedForEnsureWarm,
  acpSupportsWorkspaceMcp,
} from "../lib/acp-capabilities";
import type { AcpStatus } from "../lib/acp-types";

const CANARY_URL =
  "https://github.com/mako-ai/mako/releases/tag/desktop-canary";

/**
 * Single sticky “Desktop outdated” banner for Chat + Settings.
 * Shown when Local Agent lacks MCP attach and/or ensure/warm (bridge &lt; 7).
 */
export function AcpDesktopOutdatedBanner(props: {
  status: AcpStatus | null | undefined;
  /** Compact Chat strip vs Settings block. */
  compact?: boolean;
  /**
   * Force-show even when only MCP baseline is missing (no acpBridge / &lt; 2).
   * Default: show for ensure/warm gap OR missing MCP support when status exists.
   */
  force?: boolean;
}) {
  const { status, compact, force } = props;
  if (!status) return null;

  const bridgeOk = acpSupportsWorkspaceMcp(status);
  const ensureWarmOutdated = acpIsDesktopOutdatedForEnsureWarm(status);
  const show = force || ensureWarmOutdated || !bridgeOk;
  if (!show) return null;

  const title = bridgeOk
    ? `Local Agent needs Desktop ${ACP_REQUIRED_DESKTOP_VERSION}+`
    : "Local Agent is outdated for Coding Agents";

  return (
    <Alert severity="warning" sx={{ mb: compact ? 1 : 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {acpDesktopOutdatedSummary()} Update / warm / model-switch stay disabled
        until the new Local Agent is running.
      </Typography>
      <Typography variant="caption" component="div">
        Canary:{" "}
        <Link href={CANARY_URL} target="_blank" rel="noreferrer">
          desktop-canary
        </Link>
        {bridgeOk
          ? null
          : " — or for developers: quit Desktop and run pnpm agent:start from the ACP branch."}
      </Typography>
    </Alert>
  );
}
