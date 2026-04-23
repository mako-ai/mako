import { Box, FormControlLabel, Switch, Typography } from "@mui/material";
import SettingsLayout from "./SettingsLayout";
import ThemeSelector from "../../components/ThemeSelector";

export default function SettingsAppearance() {
  return (
    <SettingsLayout title="Appearance">
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
        <FormControlLabel
          control={<Switch defaultChecked />}
          label="Show line numbers in editor"
        />
        <FormControlLabel
          control={<Switch defaultChecked />}
          label="Enable syntax highlighting"
        />
        <FormControlLabel control={<Switch />} label="Word wrap in editor" />
      </Box>
    </SettingsLayout>
  );
}
