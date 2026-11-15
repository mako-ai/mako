import {
  Box,
  Button,
  Tab,
  TableContainer,
  TableRow,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";

/** The panel's top strip: source → destination, actions on the right. */
export const PanelTopBar = styled(Box)(({ theme }) =>
  theme.unstable_sx({
    display: "flex",
    alignItems: "center",
    px: 1.5,
    py: 0.5,
    borderBottom: 1,
    borderColor: "divider",
    gap: 0.5,
    minHeight: 36,
    flexShrink: 0,
  }),
);

/** Text button in the top bar. */
export const TopBarButton = styled(Button)({
  textTransform: "none",
  fontSize: "0.75rem",
});

/** Compact button in KPI cards and tab toolbars. */
export const CompactButton = styled(Button)({
  textTransform: "none",
  fontSize: "0.72rem",
});

export const ButtonRow = styled(Box)(({ theme }) =>
  theme.unstable_sx({ display: "flex", gap: 0.5, flexWrap: "wrap" }),
);

export const KpiCard = styled(Box)(({ theme }) =>
  theme.unstable_sx({
    borderRadius: 1.5,
    p: 1.5,
    bgcolor: "background.paper",
    border: 1,
    borderColor: "divider",
    minWidth: 0,
  }),
);

export const KpiLabel = styled(Typography)(({ theme }) =>
  theme.unstable_sx({
    fontSize: "0.68rem",
    letterSpacing: 0.3,
    color: "text.secondary",
    mb: 0.25,
  }),
);

export const KpiValue = styled(Typography)(({ theme }) =>
  theme.unstable_sx({
    fontWeight: 700,
    fontSize: "1rem",
    lineHeight: 1.3,
  }),
);

export const PanelTab = styled(Tab)(({ theme }) =>
  theme.unstable_sx({
    minHeight: 36,
    py: 0.5,
    textTransform: "none",
    fontSize: "0.82rem",
  }),
);

export const BorderedTableContainer = styled(TableContainer)(({ theme }) =>
  theme.unstable_sx({ borderRadius: 1, border: 1, borderColor: "divider" }),
);

/** Header row of the panel's dense tables. */
export const DenseHeadRow = styled(TableRow)(({ theme }) =>
  theme.unstable_sx({
    "& th": {
      fontSize: "0.72rem",
      color: "text.secondary",
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },
  }),
);
