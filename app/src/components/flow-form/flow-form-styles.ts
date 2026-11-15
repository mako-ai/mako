import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";

/** A bordered block inside a step (one trigger, one query, …). */
export const BorderedSection = styled(Box)(({ theme }) =>
  theme.unstable_sx({
    border: 1,
    borderColor: "divider",
    borderRadius: 1,
    p: 2,
  }),
);

/** Items on one line, vertically centered (name + chips in a menu item, …). */
export const InlineRow = styled(Box)(({ theme }) =>
  theme.unstable_sx({ display: "flex", alignItems: "center", gap: 1 }),
);

/** Right-aligned row under a step holding its "Continue to …" button. */
export const StepActions = styled(Box)(({ theme }) =>
  theme.unstable_sx({ display: "flex", justifyContent: "flex-end", pt: 1 }),
);
