import React from "react";
import { Box, Typography } from "@mui/material";

interface Props {
  title: string;
  description?: string;
  children: React.ReactNode;
  /**
   * Max content width in px. Pass `"full"` for admin-style pages that should
   * stretch to the parent container (data tables, dashboards, etc).
   * Default: 900.
   */
  maxWidth?: number | "full";
}

export default function SettingsLayout({
  title,
  description,
  children,
  maxWidth = 900,
}: Props) {
  return (
    <Box
      sx={{
        height: "100%",
        overflow: "auto",
        bgcolor: "background.paper",
      }}
    >
      <Box
        sx={{
          p: 3,
          maxWidth: maxWidth === "full" ? "none" : maxWidth,
          mx: maxWidth === "full" ? 0 : "auto",
        }}
      >
        <Typography variant="h5" component="h1" sx={{ mb: 1, fontWeight: 600 }}>
          {title}
        </Typography>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {description}
          </Typography>
        )}
        {children}
      </Box>
    </Box>
  );
}
