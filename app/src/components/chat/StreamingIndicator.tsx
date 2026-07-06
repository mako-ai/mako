import { Box } from "@mui/material";
import {
  streamingIndicatorContainerSx,
  streamingIndicatorDotSx,
} from "./streaming-indicator-styles";

// StreamingIndicator - Shows pulsing dot while content is being streamed
// (not memoized) so it picks up theme updates when the parent palette changes
export function StreamingIndicator() {
  return (
    <Box component="span" sx={streamingIndicatorContainerSx}>
      <Box sx={streamingIndicatorDotSx} />
    </Box>
  );
}
