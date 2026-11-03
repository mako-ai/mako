import { Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useFlowStore } from "../store/flowStore";
import { formatRelativeTime } from "../utils/relative-time";

/**
 * One line that says how a sync is doing, one part per trigger that is on:
 * the last change webhooks applied, the last poll, the last full resync.
 * Read-only; a part with nothing yet says "never".
 */
export function SyncStatusLine({
  workspaceId,
  flowId,
  poll,
  webhook,
  resync,
  lastPollAt,
  lastResyncAt,
}: {
  workspaceId: string;
  flowId: string;
  poll: boolean;
  webhook: boolean;
  resync: boolean;
  lastPollAt?: string | null;
  lastResyncAt?: string | null;
}) {
  const fetchCdcStatus = useFlowStore(s => s.fetchCdcStatus);
  const [lastChangeAt, setLastChangeAt] = useState<string | null>(null);

  useEffect(() => {
    if (!webhook) return;
    let cancelled = false;
    void fetchCdcStatus(workspaceId, flowId).then(status => {
      if (!cancelled) setLastChangeAt(status?.lastMaterializedAt ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCdcStatus, workspaceId, flowId, webhook]);

  const when = (value?: string | null) => formatRelativeTime(value) ?? "never";
  const parts = [
    webhook ? `Webhooks: last change ${when(lastChangeAt)}` : null,
    poll ? `Polled ${when(lastPollAt)}` : null,
    resync ? `Resynced ${when(lastResyncAt)}` : null,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;

  return (
    <Typography
      variant="caption"
      sx={{ color: "text.secondary" }}
      data-testid="sync-status-line"
    >
      {parts.join(" · ")}
    </Typography>
  );
}
