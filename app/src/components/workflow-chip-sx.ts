/**
 * Compact status chip for the workflows explorer. Lives in
 * its own module so the explorer does not statically pull in WorkflowView
 * (which Editor.tsx loads lazily).
 */
export const SMALL_CHIP_SX = {
  height: 16,
  fontSize: "0.62rem",
  flexShrink: 0,
  "& .MuiChip-label": { px: 0.5 },
} as const;
