/**
 * A status as a dot: a spinner while it runs, hollow for a step that did not
 * run. The caller gives the colour, from its own status map.
 */
import { Box, CircularProgress } from "@mui/material";
import { isActiveRun } from "../store/workflowsStore";

export default function StatusDot({
  status,
  color,
  hollow = false,
}: {
  status?: string;
  color: string;
  hollow?: boolean;
}) {
  if (isActiveRun(status)) return <CircularProgress size={9} />;
  return (
    <Box
      component="span"
      sx={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        display: "inline-block",
        border: hollow ? "1px solid" : "none",
        borderColor: color,
        backgroundColor: hollow ? "transparent" : color,
      }}
    />
  );
}
