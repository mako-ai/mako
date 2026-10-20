/**
 * An app's picture: the `thumbnail.*` its builder ships at the app's root
 * (GET /apps/:id/thumbnail, versioned by blob oid), otherwise a generated
 * placeholder — the Mako mark and the app's initials on a colour derived from
 * its id, so the same app looks the same everywhere. Apps without a
 * thumbnail make no request; an image that fails to load falls back to the
 * placeholder without a broken-image flash.
 */
import { useState } from "react";
import { Box } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import {
  appThumbnailUrl,
  placeholderFor,
  thumbnailAtWidth,
  thumbnailSrcSet,
  type DiscoveryApp,
} from "../../lib/apps-discovery";

/** The Mako mark (public/mako-icon.svg), inline so it takes currentColor. */
const MAKO_MARK =
  "m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z";

function MakoMark({ size, opacity }: { size: number; opacity: number }) {
  return (
    <Box
      component="svg"
      viewBox="0 0 102 90"
      aria-hidden
      sx={{ width: size, height: (size * 90) / 102, opacity, display: "block" }}
    >
      <path d={MAKO_MARK} fill="currentColor" />
    </Box>
  );
}

export default function AppThumbnail({
  workspaceId,
  app,
}: {
  workspaceId: string;
  app: Pick<DiscoveryApp, "id" | "title" | "thumbnail">;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = failed ? null : appThumbnailUrl(workspaceId, app);
  const { initials, hue } = placeholderFor(app);
  const ink = `hsl(${hue} 45% ${dark ? "80%" : "28%"})`;

  return (
    <Box
      sx={{
        position: "relative",
        aspectRatio: "16 / 10",
        overflow: "hidden",
        borderBottom: 1,
        borderColor: "divider",
        background: dark
          ? `linear-gradient(135deg, hsl(${hue} 32% 28%), hsl(${(hue + 40) % 360} 36% 16%))`
          : `linear-gradient(135deg, hsl(${hue} 55% 90%), hsl(${(hue + 40) % 360} 50% 80%))`,
      }}
    >
      {!loaded && (
        <Box
          aria-hidden
          sx={{
            position: "absolute",
            inset: 0,
            color: ink,
            userSelect: "none",
          }}
        >
          <Box sx={{ position: "absolute", top: 12, left: 12 }}>
            <MakoMark size={18} opacity={0.7} />
          </Box>
          <Box sx={{ position: "absolute", right: "-6%", bottom: "-12%" }}>
            <MakoMark size={150} opacity={0.12} />
          </Box>
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {initials}
          </Box>
        </Box>
      )}
      {src && (
        <Box
          component="img"
          src={thumbnailAtWidth(src, 640)}
          srcSet={thumbnailSrcSet(src)}
          // Cards are 160–440 px (AppsHome grid): half the viewport on a
          // phone, ~300 px otherwise.
          sizes="(max-width: 599px) 50vw, 300px"
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
            opacity: loaded ? 1 : 0,
            transition: "opacity 150ms ease",
          }}
        />
      )}
    </Box>
  );
}
