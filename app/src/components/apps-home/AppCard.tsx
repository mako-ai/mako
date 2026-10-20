/**
 * One app on the Apps home: picture, title, description (from mako.json),
 * and a meta line — owner, visit-days in the last 28 days, data freshness — plus a
 * `Verified` badge for curated apps and, on the Needs attention shelf, why.
 */
import {
  Box,
  Card,
  CardActionArea,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  BadgeCheck as VerifiedIcon,
  Eye as ViewersIcon,
  Lock as PrivateIcon,
  RefreshCw as FreshnessIcon,
  TriangleAlert as AttentionIcon,
} from "lucide-react";
import AppThumbnail from "./AppThumbnail";
import { folderLabel } from "../../lib/command-palette/app-search";
import {
  describeAttention,
  ownerHandle,
  relativeTime,
  visitSummary,
  type AppUsageStats,
  type AttentionReason,
  type DiscoveryApp,
} from "../../lib/apps-discovery";

const SEARCH_FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  path: "folder",
  owner: "owner",
  tables: "tables",
};

export interface AppCardProps {
  workspaceId: string;
  app: DiscoveryApp;
  usage?: AppUsageStats;
  attention?: AttentionReason[];
  /** Search: which fields matched. */
  matches?: string[];
  onOpen: (app: DiscoveryApp) => void;
}

export default function AppCard({
  workspaceId,
  app,
  usage,
  attention,
  matches,
  onOpen,
}: AppCardProps) {
  const owner = ownerHandle(app);
  const freshness = relativeTime(app.dataRefreshedAt);
  const visits = visitSummary(usage);
  const folder = folderLabel(app.path) ?? "";

  return (
    <Card variant="outlined" sx={{ height: "100%", minWidth: 0 }}>
      <CardActionArea
        onClick={() => onOpen(app)}
        sx={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
        }}
      >
        <AppThumbnail workspaceId={workspaceId} app={app} />
        <Box sx={{ p: 1.5, flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ alignItems: "center", minWidth: 0 }}
          >
            <Typography
              variant="subtitle2"
              noWrap
              title={app.title}
              sx={{ fontWeight: 600, minWidth: 0 }}
            >
              {app.title}
            </Typography>
            {app.verified && (
              <Tooltip title="Verified by a workspace admin">
                <Box
                  component="span"
                  sx={{ display: "inline-flex", color: "primary.main" }}
                  aria-label="Verified"
                >
                  <VerifiedIcon size={15} />
                </Box>
              </Tooltip>
            )}
            {app.access === "private" && (
              <Tooltip title="Private">
                <Box
                  component="span"
                  sx={{ display: "inline-flex", color: "text.secondary" }}
                  aria-label="Private"
                >
                  <PrivateIcon size={13} />
                </Box>
              </Tooltip>
            )}
          </Stack>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 0.25,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              minHeight: "2.6em",
              fontSize: "0.8rem",
            }}
          >
            {app.description || folder}
          </Typography>
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              mt: 1,
              alignItems: "center",
              color: "text.secondary",
              fontSize: "0.75rem",
              minWidth: 0,
              flexWrap: "wrap",
              rowGap: 0.5,
            }}
          >
            {owner && (
              <Typography
                variant="caption"
                noWrap
                sx={{ minWidth: 0, maxWidth: "45%" }}
              >
                {owner}
              </Typography>
            )}
            {visits && (
              <Tooltip title={visits.tooltip}>
                <Stack
                  direction="row"
                  spacing={0.25}
                  sx={{ alignItems: "center" }}
                >
                  <ViewersIcon size={12} />
                  <Typography variant="caption">{visits.count}</Typography>
                </Stack>
              </Tooltip>
            )}
            {freshness && (
              <Tooltip title="Data last refreshed (its least recently built data source)">
                <Stack
                  direction="row"
                  spacing={0.25}
                  sx={{ alignItems: "center", minWidth: 0 }}
                >
                  <FreshnessIcon size={11} />
                  <Typography variant="caption" noWrap>
                    {freshness}
                  </Typography>
                </Stack>
              </Tooltip>
            )}
          </Stack>
          {attention && attention.length > 0 && (
            <Stack spacing={0.25} sx={{ mt: 1 }}>
              {attention.map(reason => (
                <Stack
                  key={reason.kind}
                  direction="row"
                  spacing={0.5}
                  sx={{ alignItems: "center", color: "warning.main" }}
                >
                  <AttentionIcon size={12} />
                  <Typography variant="caption" noWrap>
                    {describeAttention(reason)}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          )}
          {matches && matches.length > 0 && (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.5 }}
            >
              {matches.map(m => (
                <Chip
                  key={m}
                  size="small"
                  variant="outlined"
                  label={SEARCH_FIELD_LABELS[m] ?? m}
                  sx={{ height: 18, fontSize: "0.68rem" }}
                />
              ))}
            </Stack>
          )}
        </Box>
      </CardActionArea>
    </Card>
  );
}
