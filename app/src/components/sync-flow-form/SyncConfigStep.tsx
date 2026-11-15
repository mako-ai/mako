import { Controller } from "react-hook-form";
import {
  Alert,
  Button,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import { NavigateNext as NextIcon } from "@mui/icons-material";
import { SYNC_MODE_COMBOS } from "@mako/schemas";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { StepActions } from "../flow-form/flow-form-styles";

export function SyncConfigStep({ model }: { model: SyncFlowFormModel }) {
  const {
    setOpenSteps,
    formTouchedRef,
    openNextStep,
    control,
    watch,
    setValue,
    watchBackfillScheduleEnabled,
    watchSyncMode,
    selectedConnector,
    selectedConnectorType,
    connectorSupportsIncremental,
    incrementalWarning,
    isBigQueryDest,
    isCdcCapableDest,
    currentSyncModeValue,
    currentSyncModeCombo,
    currentSyncModeIsOrphaned,
    syncModeMenuCombos,
    suggestReconcile,
  } = model;
  return (
    <Stack spacing={3}>
      <FormControl fullWidth>
        <InputLabel>Sync Mode</InputLabel>
        <Select
          label="Sync Mode"
          value={`${watch("syncMode")}:${watch("writeMode")}`}
          onChange={e => {
            const combo = SYNC_MODE_COMBOS.find(
              c => c.value === e.target.value,
            );
            if (!combo) return;
            formTouchedRef.current = true;
            setValue("syncMode", combo.syncMode, {
              shouldDirty: true,
            });
            setValue("writeMode", combo.writeMode, {
              shouldDirty: true,
            });
          }}
        >
          {syncModeMenuCombos.map(combo => (
            <MenuItem key={combo.value} value={combo.value}>
              {combo.label}
              {currentSyncModeIsOrphaned &&
                combo.value === currentSyncModeValue &&
                " (unsupported — pick a different mode)"}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>
          {currentSyncModeCombo?.help ??
            "How records are read and written each run."}
        </FormHelperText>
      </FormControl>

      {currentSyncModeIsOrphaned && (
        <Alert severity="warning">
          This sync was saved as Incremental before{" "}
          {selectedConnector?.name || "this connector"} lost support for it (or
          the selected entities changed). It keeps running as-is until you pick
          a different Sync Mode above and save.
        </Alert>
      )}

      {!connectorSupportsIncremental &&
        selectedConnectorType &&
        !currentSyncModeIsOrphaned && (
          <Alert severity="info">
            Incremental is hidden —{" "}
            {selectedConnector?.name || "this connector"} has no way to fetch
            only changed records for the selected entities, so every run would
            silently re-fetch everything anyway. Use Full Refresh, and add the
            webhook trigger or a periodic full reconcile to stay current between
            runs.
          </Alert>
        )}

      {watchSyncMode === "incremental" && incrementalWarning && (
        <Alert severity="warning">{incrementalWarning}</Alert>
      )}

      {suggestReconcile && (
        <Alert
          severity="info"
          action={
            !watchBackfillScheduleEnabled ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  formTouchedRef.current = true;
                  setValue("backfillScheduleEnabled", true, {
                    shouldDirty: true,
                  });
                  setOpenSteps(prev => {
                    const next = new Set(prev);
                    next.add(4);
                    return next;
                  });
                }}
              >
                Enable reconcile
              </Button>
            ) : undefined
          }
        >
          {watchBackfillScheduleEnabled
            ? "Periodic full reconcile is on — it covers updates and snapshot entities that Incremental polls cannot see."
            : "Enable the periodic full reconcile trigger (step 3) so created-anchor / full-repull entities stay current."}
        </Alert>
      )}

      {isCdcCapableDest && (
        <Controller
          name="deleteMode"
          control={control}
          render={({ field }) => (
            <FormControl fullWidth>
              <InputLabel>Delete Mode</InputLabel>
              <Select
                {...field}
                label="Delete Mode"
                value={isBigQueryDest ? "soft" : field.value || "hard"}
                disabled={isBigQueryDest}
              >
                {!isBigQueryDest && (
                  <MenuItem value="hard">Hard delete (remove rows)</MenuItem>
                )}
                <MenuItem value="soft">
                  Soft delete (set is_deleted flag)
                </MenuItem>
              </Select>
              <FormHelperText>
                {isBigQueryDest
                  ? "BigQuery syncs always use soft delete (CDC tombstones)."
                  : "How source deletions are applied in the destination"}
              </FormHelperText>
            </FormControl>
          )}
        />
      )}

      <StepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(2)}
        >
          Continue to Entities
        </Button>
      </StepActions>
    </Stack>
  );
}
