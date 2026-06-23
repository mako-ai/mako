/**
 * Shared style for the round 38×38 icon buttons used in mobile toolbars
 * (`Chat`, `Editor`). Components that render the button inside a flex row that
 * may shrink it should spread `flexShrink: 0` on top.
 */
export const MOBILE_FLOAT_BTN_SX = {
  width: 38,
  height: 38,
  borderRadius: "50%",
  color: "text.secondary",
  bgcolor: "background.paper",
  border: 1,
  borderColor: "divider",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  backdropFilter: "blur(8px)",
  "&:hover": { bgcolor: "action.hover" },
} as const;
