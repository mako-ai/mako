/**
 * AppCostChip — the app's warehouse "guilt meter".
 *
 * A quiet toolbar chip showing the last-7-days estimated warehouse cost for
 * this app's queries (editor previews, published viewers, materialization
 * builds), with a popover breaking down 24h / 7d / 90d per engine. Only
 * per-query-metered engines (BigQuery) carry a dollar figure; provisioned
 * engines show run counts. Tracking is prospective — the meter starts at
 * zero when cost capture shipped, and history is bounded by the 90-day
 * retention of query executions.
 */
import React from "react";
import { Box, ButtonBase, Popover, Tooltip } from "@mui/material";
import { CircleDollarSign } from "lucide-react";
import { api } from "../api/client";
import { BUI_MONO_FONT_FAMILY } from "./chat/bui-styles";
import { formatCostUsd } from "./chat/response-cost";

interface EngineUsage {
  databaseType: string;
  runs: number;
  bytesScanned: number;
  executionTimeMs: number;
  errors: number;
  estimatedCostUsd: number | null;
}

interface CostWindow {
  byEngine: EngineUsage[];
}

interface AppCost {
  last24h: CostWindow;
  last7d: CostWindow;
  last90d: CostWindow;
}

function windowCostUsd(w: CostWindow): number | null {
  let total: number | null = null;
  for (const e of w.byEngine) {
    if (typeof e.estimatedCostUsd === "number") {
      total = (total ?? 0) + e.estimatedCostUsd;
    }
  }
  return total;
}

function windowRuns(w: CostWindow): number {
  return w.byEngine.reduce((n, e) => n + e.runs, 0);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes} B`;
}

const WINDOWS = [
  { key: "last24h", label: "24h" },
  { key: "last7d", label: "7d" },
  { key: "last90d", label: "90d" },
] as const;

export const AppCostChip = React.memo(function AppCostChip({
  workspaceId,
  appId,
}: {
  workspaceId: string;
  appId: string;
}) {
  const [cost, setCost] = React.useState<AppCost | null>(null);
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.GET(
          "/api/workspaces/{workspaceId}/apps/{id}/cost",
          { params: { path: { workspaceId, id: appId } } },
        );
        const payload = result.data as
          | { success?: boolean; cost?: AppCost }
          | undefined;
        if (!cancelled && payload?.success && payload.cost) {
          setCost(payload.cost);
        }
      } catch {
        // Guilt meter is best-effort chrome — never surface fetch errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, appId]);

  if (!cost || windowRuns(cost.last90d) === 0) return null;

  const cost7d = windowCostUsd(cost.last7d);
  const chipLabel =
    cost7d != null
      ? `${formatCostUsd(cost7d)} · 7d`
      : `${windowRuns(cost.last7d)} runs · 7d`;

  return (
    <>
      <Tooltip title="Warehouse usage for this app — click for the breakdown">
        <ButtonBase
          onClick={e => setAnchor(e.currentTarget)}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.5,
            height: 24,
            px: 1,
            borderRadius: "999px",
            flexShrink: 0,
            backgroundColor: "var(--bui-field)",
            boxShadow: "var(--bui-shadow-hairline)",
            color: "var(--bui-ink-2)",
            fontFamily: BUI_MONO_FONT_FAMILY,
            fontSize: "11px",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            transition: "background-color 0.1s",
            "&:hover": { backgroundColor: "var(--bui-hover-2)" },
          }}
        >
          <CircleDollarSign size={12} />
          {chipLabel}
        </ButtonBase>
      </Tooltip>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ p: 1.5, minWidth: 300 }}>
          <Box
            sx={{
              fontSize: "11.5px",
              fontWeight: 600,
              color: "var(--bui-ink-3)",
              letterSpacing: 0.2,
              mb: 1,
            }}
          >
            Warehouse usage
          </Box>
          {WINDOWS.map(({ key, label }) => {
            const w = cost[key];
            const usd = windowCostUsd(w);
            return (
              <Box key={key} sx={{ mb: 1 }}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 1,
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      width: 34,
                      flexShrink: 0,
                      fontFamily: BUI_MONO_FONT_FAMILY,
                      fontSize: "11px",
                      color: "var(--bui-ink-3)",
                    }}
                  >
                    {label}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontFamily: BUI_MONO_FONT_FAMILY,
                      fontSize: "12.5px",
                      fontWeight: 600,
                      color: "var(--bui-ink)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {usd != null ? formatCostUsd(usd) : "—"}
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      fontSize: "11.5px",
                      color: "var(--bui-ink-3)",
                    }}
                  >
                    {windowRuns(w)} runs
                  </Box>
                </Box>
                {w.byEngine.map(e => (
                  <Box
                    key={e.databaseType}
                    sx={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 1,
                      pl: "42px",
                      fontSize: "11px",
                      color: "var(--bui-ink-2)",
                    }}
                  >
                    <Box component="span" sx={{ minWidth: 72 }}>
                      {e.databaseType}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        fontFamily: BUI_MONO_FONT_FAMILY,
                        color: "var(--bui-ink-3)",
                      }}
                    >
                      {e.estimatedCostUsd != null
                        ? `${formatCostUsd(e.estimatedCostUsd)} · ${formatBytes(e.bytesScanned)}`
                        : `${e.runs} runs`}
                      {e.errors > 0 ? ` · ${e.errors} failed` : ""}
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          })}
          <Box
            sx={{
              mt: 1,
              pt: 1,
              borderTop: "1px solid var(--bui-line)",
              fontSize: "10.5px",
              color: "var(--bui-ink-3)",
            }}
          >
            Estimated at on-demand list price. Tracking since Aug 2026; history
            kept 90 days.
          </Box>
        </Box>
      </Popover>
    </>
  );
});
AppCostChip.displayName = "AppCostChip";
