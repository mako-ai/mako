import type { Theme } from "@mui/material";

export interface RailButtonColors {
  color: string;
  backgroundColor: string;
  hoverBackgroundColor: string;
  /** Keyboard focus ring (`.Mui-focusVisible`); ripples are off app-wide. */
  focusOutlineColor: string;
}

/**
 * Colours for one rail button. Neutral only — the rail carries no brand
 * colour in any state (hover and focus included), by design.
 *
 * The rail marks one thing: which explorer panel is on screen (`isActive`),
 * as a full-contrast icon on the selected background. Every other button is
 * the same muted grey — the explorer holding the open tab gets no hint, since
 * any second marker read as the highlight following the tab.
 */
export function railButtonColors(
  theme: Theme,
  { isActive }: { isActive?: boolean },
): RailButtonColors {
  const focusOutlineColor = theme.palette.text.secondary;
  if (isActive) {
    return {
      color: theme.palette.text.primary,
      backgroundColor: theme.palette.action.selected,
      hoverBackgroundColor: theme.palette.action.selected,
      focusOutlineColor,
    };
  }
  return {
    color: theme.palette.text.secondary,
    backgroundColor: "transparent",
    hoverBackgroundColor: theme.palette.action.hover,
    focusOutlineColor,
  };
}
