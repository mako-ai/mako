import { Box, Typography } from "@mui/material";
import SettingsLayout from "./SettingsLayout";
import ThemeSelector from "../../components/ThemeSelector";

export default function SettingsAppearance() {
  return (
    <SettingsLayout title="Appearance">
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="body1">Theme</Typography>
        <ThemeSelector />
      </Box>
    </SettingsLayout>
  );
}
