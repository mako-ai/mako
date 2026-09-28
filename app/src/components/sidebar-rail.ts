import type { Theme } from "@mui/material";

/**
 * Colours for one rail button.
 *
 * The rail answers two questions: which explorer panel is on screen
 * (`isActive`) and which explorer holds the tab in the editor
 * (`ownsActiveTab`). Only the first is THE highlight: the brand colour plus the
 * selected background, so the lit icon always names what the explorer shows.
 *
 * The second is a quieter hint — full-strength text colour instead of the
 * muted idle colour, no background. It used to be the brand colour, which
 * made it the loudest thing on the rail: with a console tab open and Flows in
 * the explorer, Consoles lit up blue while Flows only got a faint grey
 * background, so the highlight read as following the tab instead of the panel.
 */
export function railButtonColors(
  theme: Theme,
  { isActive, ownsActiveTab }: { isActive?: boolean; ownsActiveTab?: boolean },
): { color: string; backgroundColor: string; hoverBackgroundColor: string } {
  if (isActive) {
    return {
      color: theme.palette.primary.main,
      backgroundColor: theme.palette.action.selected,
      hoverBackgroundColor: theme.palette.action.selected,
    };
  }
  return {
    color: ownsActiveTab
      ? theme.palette.text.primary
      : theme.palette.text.secondary,
    backgroundColor: "transparent",
    hoverBackgroundColor: theme.palette.action.hover,
  };
}
