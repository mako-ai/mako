import { Box, Button, Typography } from "@mui/material";
import { SearchX, Lock, AlertTriangle } from "lucide-react";
import type { LoadError } from "../api";

/**
 * Shared load states for any entity opened in a tab (app, dashboard, console,
 * flow, dbt project, file, data source, ...). Every tab view should render one
 * of these instead of a bespoke placeholder so a 404/403/transport failure is
 * always explicit and never an infinite "Loading…".
 *
 *  - `EntityLoadErrorState` — fetch failed: "not found" / "no access" copy
 *    from the HTTP status, or the server message with a Retry affordance.
 *  - `EntityLoadingState`   — the standardized loading placeholder.
 *
 * For a sub-entity that vanished from an already-loaded parent (file removed
 * from an app, data source removed from a dashboard, ...), synthesize the 404
 * with `missingEntityError` from lib/entity-labels.
 */
export default function EntityLoadErrorState({
  error,
  entityLabel,
  detail,
  onRetry,
}: {
  error: LoadError;
  /** Lowercase noun for the copy, e.g. "app", "dashboard", "file". */
  entityLabel: string;
  /** Overrides the default body copy (title stays status-derived). */
  detail?: string;
  onRetry?: () => void;
}) {
  const notFound = error.status === 404;
  const forbidden = error.status === 403;

  const Icon = notFound ? SearchX : forbidden ? Lock : AlertTriangle;
  const title = notFound
    ? `${capitalize(entityLabel)} not found`
    : forbidden
      ? `You don't have access to this ${entityLabel}`
      : `Failed to load ${entityLabel}`;
  const detailText =
    detail ??
    (notFound
      ? `This ${entityLabel} may have been deleted, or it belongs to a different workspace.`
      : forbidden
        ? `Ask the owner to share this ${entityLabel} with you.`
        : error.message);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        p: 3,
        textAlign: "center",
        color: "text.secondary",
      }}
    >
      <Icon size={28} strokeWidth={1.5} />
      <Typography variant="subtitle1" color="text.primary">
        {title}
      </Typography>
      <Typography variant="body2" sx={{ maxWidth: 420 }}>
        {detailText}
      </Typography>
      {onRetry && !notFound && !forbidden && (
        <Button
          size="small"
          variant="outlined"
          onClick={onRetry}
          sx={{ mt: 1 }}
        >
          Retry
        </Button>
      )}
    </Box>
  );
}

/** Standardized "Loading <entity>…" placeholder for tab views. */
export function EntityLoadingState({ label }: { label: string }) {
  return (
    <Box sx={{ p: 3, color: "text.secondary" }}>
      <Typography variant="body2">{label}</Typography>
    </Box>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
