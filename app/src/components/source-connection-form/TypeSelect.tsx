import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Typography,
} from "@mui/material";
import { Controller } from "react-hook-form";
import { connectorIconUrl } from "../../lib/connector-icon";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

export function TypeSelect({ model }: { model: SourceConnectionFormModel }) {
  const { connectorTypes, currentWorkspace, control, errors, readOnly } = model;
  return (
    <FormControl fullWidth margin="normal">
      <InputLabel>Connector Type</InputLabel>
      <Controller
        name="type"
        control={control}
        rules={{ required: true }}
        render={({ field }) => (
          <Select
            {...field}
            variant="outlined"
            size="small"
            disabled={readOnly}
          >
            {connectorTypes.map(connector => (
              <MenuItem key={connector.type} value={connector.type}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Box
                    component="img"
                    src={connectorIconUrl(connector.type, currentWorkspace?.id)}
                    alt={`${connector.type} icon`}
                    sx={{ width: 20, height: 20 }}
                  />
                  {connector.name}
                </Box>
              </MenuItem>
            ))}
          </Select>
        )}
      />
      {errors.type && (
        <Typography variant="caption" color="error" sx={{ ml: 2 }}>
          Connector type is required
        </Typography>
      )}
    </FormControl>
  );
}
