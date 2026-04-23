import { useState } from "react";
import { Box, Button, TextField } from "@mui/material";
import SettingsLayout from "./SettingsLayout";

export default function SettingsOpenAI() {
  const [openaiApiKey, setOpenaiApiKey] = useState(
    localStorage.getItem("openai_api_key") || "",
  );

  const save = () => {
    localStorage.setItem("openai_api_key", openaiApiKey);
  };

  return (
    <SettingsLayout
      title="OpenAI Configuration"
      description="Add a personal OpenAI API key for any legacy flows that require it."
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <TextField
          label="OpenAI API Key"
          value={openaiApiKey}
          onChange={e => setOpenaiApiKey(e.target.value)}
          type="password"
          fullWidth
          placeholder="sk-..."
          helperText="Stored in browser localStorage only."
        />
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            variant="contained"
            onClick={save}
            disableElevation
            disabled={!openaiApiKey.trim()}
          >
            Save
          </Button>
          <Button variant="outlined" disabled={!openaiApiKey.trim()}>
            Test API Key
          </Button>
        </Box>
      </Box>
    </SettingsLayout>
  );
}
