/**
 * An archived app on the Apps home's Archived chip: greyed, with when it was
 * archived and where Restore puts it back. Not clickable as a whole — an
 * archived app has no live view to open — only its Restore button is.
 */
import { Box, Button, Card, Stack, Tooltip, Typography } from "@mui/material";
import { ArchiveRestore as RestoreIcon } from "lucide-react";
import AppThumbnail from "./AppThumbnail";
import {
  archivedThumbnailUrl,
  type ArchivedApp,
} from "../../lib/apps-discovery";

function archivedLabel(app: ArchivedApp): string {
  if (!app.archivedAt) return "Archived";
  const at = new Date(app.archivedAt);
  const day = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() !== new Date().getFullYear()
      ? { year: "numeric" as const }
      : {}),
  });
  return `Archived on ${day}`;
}

export default function ArchivedAppCard({
  workspaceId,
  app,
  onRestore,
}: {
  workspaceId: string;
  app: ArchivedApp;
  onRestore: (app: ArchivedApp) => void;
}) {
  const by = app.archivedBy?.name;
  return (
    <Card
      variant="outlined"
      component="article"
      aria-label={`${app.title} (archived)`}
      sx={{
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        bgcolor: "action.hover",
      }}
    >
      <Box sx={{ filter: "grayscale(1)", opacity: 0.55 }}>
        <AppThumbnail
          workspaceId={workspaceId}
          app={{
            id: app.appId ?? app.path,
            title: app.title,
            thumbnail: app.thumbnail,
          }}
          src={archivedThumbnailUrl(workspaceId, app)}
        />
      </Box>
      <Box sx={{ p: 1.5, flex: 1, minWidth: 0 }}>
        <Typography
          variant="subtitle2"
          noWrap
          title={app.title}
          sx={{ fontWeight: 600, color: "text.secondary" }}
        >
          {app.title}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.disabled",
            mt: 0.25,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            minHeight: "2.6em",
            fontSize: "0.8rem",
          }}
        >
          {app.description || app.originalPath}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            mt: 1,
            alignItems: "center",
            justifyContent: "space-between",
            minWidth: 0,
          }}
        >
          <Tooltip
            title={`${by ? `By ${by}. ` : ""}Restores to ${app.originalPath}`}
          >
            <Typography
              variant="caption"
              noWrap
              sx={{ color: "text.secondary", minWidth: 0 }}
            >
              {archivedLabel(app)}
            </Typography>
          </Tooltip>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RestoreIcon size={14} />}
            onClick={() => onRestore(app)}
            aria-label={`Restore ${app.title}`}
            sx={{ flexShrink: 0 }}
          >
            Restore
          </Button>
        </Stack>
      </Box>
    </Card>
  );
}
