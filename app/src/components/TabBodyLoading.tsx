import { Box, CircularProgress } from "@mui/material";

/** Centered spinner shown while a lazily loaded tab body downloads. */
export function TabBodyLoading() {
  return (
    <Box
      sx={{
        flex: 1,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <CircularProgress size={24} />
    </Box>
  );
}
