/**
 * Beautiful UI task-row status primitives, shared by every surface that shows
 * a queued/running/success/error lifecycle (chat dbt run card, connector sync
 * history, backfill panel, scheduled runs). Colors come from the --bui-* CSS
 * variables in index.css, so all pieces are theme-reactive module constants.
 */
/* eslint-disable react-refresh/only-export-components -- style-constant
   module: components and their shared sx/tone helpers ship together */
import { forwardRef } from "react";
import { Box } from "@mui/material";
import { Check, Square, X } from "lucide-react";
import { BUI_MONO_FONT_FAMILY } from "./chat/bui-styles";

export type BuiPillTone = "green" | "red" | "orange" | "accent" | "neutral";

/** Bridge for call sites migrating off MUI Chip `color` names. */
export function pillToneForMuiColor(
  color: "success" | "info" | "error" | "warning" | "default",
): BuiPillTone {
  switch (color) {
    case "success":
      return "green";
    case "error":
      return "red";
    case "warning":
      return "orange";
    case "info":
      return "accent";
    default:
      return "neutral";
  }
}

const PILL_TONE_SX: Record<
  BuiPillTone,
  { backgroundColor: string; color: string }
> = {
  green: {
    backgroundColor: "var(--bui-green-tint)",
    color: "var(--bui-green)",
  },
  red: { backgroundColor: "var(--bui-red-tint)", color: "var(--bui-red)" },
  orange: {
    backgroundColor: "var(--bui-orange-tint)",
    color: "var(--bui-orange)",
  },
  accent: {
    backgroundColor: "var(--bui-accent-tint)",
    color: "var(--bui-accent-ink)",
  },
  neutral: {
    backgroundColor: "var(--bui-field)",
    color: "var(--bui-ink-2)",
  },
};

/** Rounded tint pill for lifecycle statuses ("Completed", "Failed", …).
 * Forwards ref + props so it can sit directly inside a MUI Tooltip. */
export const StatusPill = forwardRef<
  HTMLSpanElement,
  {
    tone: BuiPillTone;
    children: React.ReactNode;
    /** Fade in on mount (for pills that appear when a run resolves). */
    animateIn?: boolean;
  } & React.HTMLAttributes<HTMLSpanElement>
>(function StatusPill({ tone, children, animateIn = false, ...rest }, ref) {
  return (
    <Box
      component="span"
      ref={ref}
      {...rest}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        height: 22,
        px: 1,
        borderRadius: "999px",
        fontSize: "11.5px",
        fontWeight: 500,
        flexShrink: 0,
        whiteSpace: "nowrap",
        ...PILL_TONE_SX[tone],
        ...(animateIn && { animation: "bui-fade-in 200ms ease-out both" }),
      }}
    >
      {children}
    </Box>
  );
});

/** BUI Task Rows badge: track ring with a rotating arc while active. */
export function SpinnerRingBadge({ size = 22 }: { size?: number }) {
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <Box
      component="span"
      sx={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Box
        component="svg"
        width={size}
        height={size}
        sx={{
          position: "absolute",
          inset: 0,
          animation: "spin 1.1s linear infinite",
          "@keyframes spin": { to: { transform: "rotate(1turn)" } },
        }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--bui-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--bui-ink-3)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c * 0.72}`}
        />
      </Box>
    </Box>
  );
}

/** Filled circular badge (green check / red cross / neutral square). */
export function ResultBadge({
  tone,
  size = 22,
}: {
  tone: "green" | "red" | "neutral";
  size?: number;
}) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        color: "#fff",
        backgroundColor:
          tone === "green"
            ? "var(--bui-green)"
            : tone === "red"
              ? "var(--bui-red)"
              : "var(--bui-ink-3)",
        animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both",
      }}
    >
      {tone === "green" ? (
        <Check size={size * 0.59} strokeWidth={3.5} />
      ) : tone === "red" ? (
        <X size={size * 0.55} strokeWidth={3.5} />
      ) : (
        <Square size={size * 0.41} strokeWidth={3} fill="currentColor" />
      )}
    </Box>
  );
}

/** Small mono field chip for run metadata (env, branch, counts). */
export const BUI_META_CHIP_SX = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  px: 0.75,
  borderRadius: "5px",
  backgroundColor: "var(--bui-field)",
  boxShadow: "var(--bui-shadow-hairline)",
  fontFamily: BUI_MONO_FONT_FAMILY,
  fontSize: "0.64rem",
  color: "var(--bui-ink-2)",
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/** Ghost icon button (row actions: cancel, open, …). */
export const BUI_GHOST_ICON_BTN_SX = {
  p: 0.25,
  color: "var(--bui-ink-3)",
  "&:hover": {
    color: "var(--bui-ink)",
    backgroundColor: "var(--bui-hover-2)",
  },
} as const;
