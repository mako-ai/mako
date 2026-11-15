import {
  Box,
  Button,
  Typography,
  Alert,
  FormControlLabel,
  Switch,
  Stack,
} from "@mui/material";
import { NavigateNext as NextIcon } from "@mui/icons-material";
import { SchemaMappingTable } from "../SchemaMappingTable";
import type { DbFlowFormModel } from "./useDbFlowForm";
import { SpacedStepActions } from "../flow-form/flow-form-styles";

export function DbSchemaMappingStep({ model }: { model: DbFlowFormModel }) {
  const {
    setValue,
    watchTypeCoercions,
    watchSchemaMappingConfirmed,
    openNextStep,
    selectedDestConnection,
    handleTypeCoercionsChange,
  } = model;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Review and adjust the destination column types. The AI agent can help
          inspect your source table and suggest optimal types. You can also
          manually adjust any column&apos;s destination type using the dropdowns
          below.
        </Typography>

        <SchemaMappingTable
          columns={watchTypeCoercions || []}
          onChange={handleTypeCoercionsChange}
          destinationType={selectedDestConnection?.type || "bigquery"}
        />

        {watchTypeCoercions?.length === 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography variant="body2">
              No columns detected yet. Go back to Step 1 and validate your
              query, or ask the AI agent to help configure the schema mapping.
            </Typography>
          </Alert>
        )}

        {watchTypeCoercions?.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={watchSchemaMappingConfirmed || false}
                  onChange={e =>
                    setValue("schemaMappingConfirmed", e.target.checked)
                  }
                />
              }
              label={
                <Typography variant="body2">
                  I have reviewed and confirmed the column type mappings
                </Typography>
              }
            />
          </Box>
        )}
      </Box>

      <SpacedStepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(2)}
        >
          Continue to Sync Mode
        </Button>
      </SpacedStepActions>
    </Stack>
  );
}
