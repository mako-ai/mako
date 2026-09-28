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
 * The rail answers two questions: which explorer panel is on screen
 * (`isActive`) and which explorer holds the tab in the editor
 * (`ownsActiveTab`). Only the first is THE highlight: a full-contrast icon on
 * the selected background, so the marked icon always names what the explorer
 * shows. The second is a quieter hint — full-contrast icon, no background.
 *
 * It used to be the other way round: the tab owner got the brand blue and the
 * open panel only a faint grey background, so with a console tab open and
 * Flows in the explorer, Consoles lit up blue and the highlight read as
 * following the tab instead of the panel.
 */
export function railButtonColors(
  theme: Theme,
  { isActive, ownsActiveTab }: { isActive?: boolean; ownsActiveTab?: boolean },
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
    color: ownsActiveTab
      ? theme.palette.text.primary
      : theme.palette.text.secondary,
    backgroundColor: "transparent",
    hoverBackgroundColor: theme.palette.action.hover,
    focusOutlineColor,
  };
}
