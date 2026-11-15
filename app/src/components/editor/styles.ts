import { Tab, Tabs, styled } from "@mui/material";
import { Separator } from "react-resizable-panels";

// Styled Separator components
export const StyledVerticalResizeHandle = styled(Separator)(({ theme }) => ({
  height: "4px",
  background: theme.palette.divider,
  transition: "background-color 0.2s ease",
  // The library flags hover/drag via a data attribute (its hit area extends
  // beyond the 4px strip), so key the highlight off that instead of :hover.
  "&[data-separator='hover'], &[data-separator='active']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

/** 36px tab strip shared by the editor tab bar and the results/runs switch. */
export const CompactTabs = styled(Tabs)({
  minHeight: 36,
  "& .MuiTabs-indicator": { height: 2 },
});

/** "Results" / "Runs" switch tab above a console's bottom pane. */
export const ResultsPaneTab = styled(Tab)(({ theme }) => ({
  minHeight: 36,
  padding: theme.spacing(0.25, 1.25),
  minWidth: 0,
  textTransform: "none",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: theme.palette.text.secondary,
  "&.Mui-selected": {
    color: theme.palette.text.primary,
  },
  "&.Mui-disabled": {
    opacity: 0.5,
  },
}));

// Claude-style floating chrome for the mobile editor header — paper fill,
// blur and a hairline so it reads as floating over the editor content.
const MOBILE_FLOAT_CHROME_SX = {
  bgcolor: "background.paper",
  border: 1,
  borderColor: "divider",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
} as const;

// Round floating button (new console).
export const MOBILE_FLOAT_BTN_SX = {
  width: 38,
  height: 38,
  flexShrink: 0,
  borderRadius: "50%",
  color: "text.secondary",
  ...MOBILE_FLOAT_CHROME_SX,
  backdropFilter: "blur(8px)",
  "&:hover": { bgcolor: "action.hover" },
} as const;

// Centered "current window" pill that opens the open-tabs switcher menu.
export const MOBILE_WINDOW_PILL_SX = {
  flex: 1,
  minWidth: 0,
  maxWidth: 320,
  height: 38,
  px: 1.5,
  textTransform: "none",
  borderRadius: 999,
  color: "text.primary",
  ...MOBILE_FLOAT_CHROME_SX,
  backdropFilter: "blur(8px)",
  "&:hover": { bgcolor: "action.hover" },
} as const;

// Icon-only pane switch that sits beside the window pill on mobile (query /
// results for a console, preview / terminal for an app in dev mode). Same
// height and pill shape as its neighbours so the header stays one row.
export const MOBILE_PANE_TOGGLE_SX = {
  height: 38,
  flexShrink: 0,
  borderRadius: 999,
  overflow: "hidden",
  ...MOBILE_FLOAT_CHROME_SX,
  "& .MuiToggleButtonGroup-grouped": {
    border: 0,
    borderRadius: 0,
    minWidth: 40,
    px: 0,
    color: "text.secondary",
    "&.Mui-selected": { color: "text.primary" },
  },
} as const;

/** Full-height flex column, the layout of most editor panes. */
export const FILL_COLUMN_SX = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
} as const;
