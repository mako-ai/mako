import React from "react";
import { Box } from "@mui/material";
import { BUI_MONO_FONT_FAMILY, buiShimmerLabelSx } from "./bui-styles";

// StreamingIndicator — Beautiful UI "Loading State" (Drive variant): a 3×3
// pixel grid with a chevron wavefront, a shimmering label, and a live elapsed
// timer in mono tabular figures. Shown while the assistant turn is streaming.

// Chevron wavefront delays: each cell fires by (column + |row-1|) * 90ms, so
// a ">" front sweeps left → right; the 650ms cycle keeps two fronts in flight.
const PIXEL_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const col = i % 3;
  return (col + Math.abs(row - 1)) * 90;
});

const containerSx = {
  display: "flex",
  alignItems: "center",
  gap: 1.25,
  mt: 1,
  width: "fit-content",
} as const;

const gridSx = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 4px)",
  gap: "1.5px",
  flexShrink: 0,
} as const;

const pixelSx = {
  width: 4,
  height: 4,
  borderRadius: "1px",
  backgroundColor: "var(--bui-ink)",
  opacity: 0.15,
} as const;

const labelSx = {
  fontSize: "13px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  ...buiShimmerLabelSx,
} as const;

const elapsedSx = {
  fontFamily: BUI_MONO_FONT_FAMILY,
  fontSize: "12px",
  color: "var(--bui-ink-3)",
  fontVariantNumeric: "tabular-nums",
} as const;

function formatElapsed(deciseconds: number): string {
  const total = deciseconds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export const StreamingIndicator = React.memo(function StreamingIndicator() {
  const [deciseconds, setDeciseconds] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setDeciseconds(d => d + 1), 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box component="span" role="status" sx={containerSx}>
      <Box component="span" aria-hidden sx={gridSx}>
        {PIXEL_DELAYS.map((delay, index) => (
          <Box
            key={index}
            component="span"
            sx={pixelSx}
            style={{
              animation: `bui-pixel-on 650ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </Box>
      <Box component="span" sx={labelSx}>
        Working
      </Box>
      <Box component="span" sx={elapsedSx}>
        {formatElapsed(deciseconds)}
      </Box>
    </Box>
  );
});
StreamingIndicator.displayName = "StreamingIndicator";
