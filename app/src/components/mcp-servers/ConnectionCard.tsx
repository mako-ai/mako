import { Box, Button, Chip, Stack, Typography } from "@mui/material";

/** Gallery card for a configured server or an available preset. */
export function ConnectionCard({
  icon,
  title,
  description,
  connected,
  statusChip,
  actionLabel,
  actionVariant = "contained",
  onAction,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  connected?: boolean;
  statusChip?: React.ReactNode;
  actionLabel: string;
  actionVariant?: "contained" | "outlined";
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2.5,
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        bgcolor: "background.paper",
        transition: "box-shadow 120ms ease, border-color 120ms ease",
        "&:hover": {
          borderColor: "text.disabled",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        },
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "flex-start",
        }}
      >
        {icon}
        <Box sx={{ flex: 1 }} />
        {connected && (
          <Chip
            label="CONNECTED"
            size="small"
            sx={{
              height: 20,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: "success.main",
              bgcolor: "transparent",
              border: 1,
              borderColor: "success.light",
              "& .MuiChip-label": { px: 1 },
            }}
            icon={
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  bgcolor: "success.main",
                  ml: 0.75,
                }}
              />
            }
          />
        )}
        {statusChip}
      </Stack>
      <Typography
        variant="subtitle2"
        sx={{
          fontWeight: 600,
          mt: 0.5,
        }}
      >
        {title}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 48,
        }}
      >
        {description}
      </Typography>
      <Button
        variant={actionVariant}
        size="small"
        fullWidth
        disabled={disabled}
        onClick={onAction}
        sx={{ mt: "auto" }}
      >
        {actionLabel}
      </Button>
    </Box>
  );
}
