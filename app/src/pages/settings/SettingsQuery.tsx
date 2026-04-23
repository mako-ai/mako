import {
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
} from "@mui/material";
import SettingsLayout from "./SettingsLayout";

export default function SettingsQuery() {
  return (
    <SettingsLayout title="Query Execution">
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <FormControl fullWidth>
          <InputLabel>Default result limit</InputLabel>
          <Select defaultValue={1000} label="Default result limit">
            <MenuItem value={100}>100 rows</MenuItem>
            <MenuItem value={500}>500 rows</MenuItem>
            <MenuItem value={1000}>1,000 rows</MenuItem>
            <MenuItem value={5000}>5,000 rows</MenuItem>
            <MenuItem value={10000}>10,000 rows</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth>
          <InputLabel>Query timeout</InputLabel>
          <Select defaultValue={30} label="Query timeout">
            <MenuItem value={10}>10 seconds</MenuItem>
            <MenuItem value={30}>30 seconds</MenuItem>
            <MenuItem value={60}>1 minute</MenuItem>
            <MenuItem value={300}>5 minutes</MenuItem>
            <MenuItem value={600}>10 minutes</MenuItem>
          </Select>
        </FormControl>
        <FormControlLabel
          control={<Switch defaultChecked />}
          label="Auto-save queries"
        />
        <FormControlLabel
          control={<Switch />}
          label="Confirm before executing destructive queries"
        />
      </Box>
    </SettingsLayout>
  );
}
