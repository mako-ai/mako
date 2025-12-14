import React from "react";
import { Box, Typography, useTheme, useMediaQuery } from "@mui/material";

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
}

export function AuthLayout({ children, title, subtitle }: AuthLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        bgcolor: "background.default",
      }}
    >
      {/* Left Side - Branding */}
      {!isMobile && (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "flex-start",
            px: 8,
            bgcolor: "primary.main",
            color: "common.white",
            position: "relative",
            overflow: "hidden",
            background: theme =>
              theme.palette.mode === "dark"
                ? `linear-gradient(135deg, ${theme.palette.background.paper} 0%, ${theme.palette.background.default} 100%)`
                : `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
          }}
        >
          {/* Decorative elements */}
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              opacity: 0.1,
              background:
                "radial-gradient(circle at 30% 50%, rgba(255, 255, 255, 0.2) 0%, transparent 50%)",
            }}
          />
          <Box
            sx={{
              position: "relative",
              zIndex: 1,
            }}
          >
            <Box
              component="img"
              src="/mako-icon.svg"
              alt="Mako"
              sx={{
                width: 64,
                height: "auto",
                mb: 4,
                filter: "brightness(0) invert(1)",
              }}
            />
            <Typography
              variant="h3"
              sx={{
                fontWeight: 600,
                lineHeight: 1.2,
                color: "inherit",
              }}
            >
              Query your data
              <br />
              in seconds.
            </Typography>
          </Box>
        </Box>
      )}

      {/* Right Side - Form */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          px: { xs: 3, sm: 6 },
          py: 4,
          bgcolor: "background.paper",
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 400 }}>
          <Typography
            variant="h4"
            sx={{ fontWeight: 600, mb: 1, color: "text.primary" }}
          >
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 4 }}>
              {subtitle}
            </Typography>
          )}

          {children}
        </Box>
      </Box>
    </Box>
  );
}
