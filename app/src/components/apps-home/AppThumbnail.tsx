/**
 * An app's picture: the screenshot of its live deployment when there is one
 * (GET /apps/:id/thumbnail — a redirect to a signed bucket URL), otherwise a
 * generated placeholder of its initials on a colour derived from its id, so
 * the same app looks the same everywhere. A missing or failed image falls
 * back to the placeholder without a broken-image flash.
 */
import { useState } from "react";
import { Box } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import {
  appThumbnailUrl,
  placeholderFor,
  type DiscoveryApp,
} from "../../lib/apps-discovery";

export default function AppThumbnail({
  workspaceId,
  app,
}: {
  workspaceId: string;
  app: Pick<DiscoveryApp, "id" | "title" | "thumbnailAt" | "publishedSha">;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Only published apps can have a picture (and asking for one is what
  // queues the backfill), so unpublished ones never make the request.
  const tryImage = !!app.publishedSha && !failed;
  const { initials, hue } = placeholderFor(app);

  return (
    <Box
      sx={{
        position: "relative",
        aspectRatio: "16 / 10",
        overflow: "hidden",
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: `hsl(${hue} ${dark ? "30%" : "45%"} ${dark ? "26%" : "88%"})`,
      }}
    >
      {!loaded && (
        <Box
          aria-hidden
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: `hsl(${hue} ${dark ? "45%" : "40%"} ${dark ? "78%" : "32%"})`,
            userSelect: "none",
          }}
        >
          {initials}
        </Box>
      )}
      {tryImage && (
        <Box
          component="img"
          src={appThumbnailUrl(workspaceId, app)}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          sx={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "top left",
            opacity: loaded ? 1 : 0,
            transition: "opacity 150ms ease",
          }}
        />
      )}
    </Box>
  );
}
