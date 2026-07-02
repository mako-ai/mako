import { keyframes } from "@mui/material/styles";

// Stable keyframes animation defined outside components to prevent re-renders
const pulseAnimation = keyframes`
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.35); }
`;

// Stable style objects to prevent re-renders. The dot is shared by the
// streaming indicator and the history menu's in-flight session marker.
export const streamingIndicatorContainerSx = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  overflow: "visible",
  lineHeight: 0,
  flexShrink: 0,
  mt: 0.5,
} as const;

export const streamingIndicatorDotSx = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  backgroundColor: "primary.main",
  animation: `${pulseAnimation} 1s infinite ease-in-out`,
} as const;
