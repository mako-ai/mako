/**
 * An app's favicon in the Apps explorer: the `icon.svg`/`icon.png` the app
 * ships at its root (GET /apps/:id/icon, versioned by blob oid), otherwise a
 * generated letter mark — the app's first letter on the hue its thumbnail
 * placeholder uses. `@makoai/app-sdk/vite` injects the same mark as the
 * app's own favicon, so the browser tab and the explorer row agree.
 */
import { useState } from "react";
import { Box } from "@mui/material";
import { appIconUrl, appLetterMark } from "../../lib/apps-discovery";

export default function AppFavicon({
  workspaceId,
  app,
  size = 16,
}: {
  workspaceId: string | undefined;
  app: { id: string; title: string; icon?: { oid: string } | null };
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = !failed && workspaceId ? appIconUrl(workspaceId, app) : null;
  if (src) {
    return (
      <Box
        component="img"
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        sx={{ display: "block", width: size, height: size, flexShrink: 0 }}
      />
    );
  }
  const { letter, hue } = appLetterMark(app);
  return (
    <Box
      component="svg"
      viewBox="0 0 32 32"
      aria-hidden
      sx={{ display: "block", width: size, height: size, flexShrink: 0 }}
    >
      <rect width="32" height="32" rx="7" fill={`hsl(${hue} 55% 42%)`} />
      <text
        x="16"
        y="22.5"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, Segoe UI, sans-serif"
        fontSize="19"
        fontWeight="700"
        fill="#fff"
      >
        {letter}
      </text>
    </Box>
  );
}
