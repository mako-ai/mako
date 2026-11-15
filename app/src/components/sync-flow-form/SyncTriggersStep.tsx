import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Add as AddIcon } from "@mui/icons-material";
import { useFlowStore } from "../../store/flowStore";
import { SyncStatusLine } from "../SyncStatusLine";
import { SyncScheduleTrigger } from "./SyncScheduleTrigger";
import { SyncWebhookTrigger } from "./SyncWebhookTrigger";
import { SyncReconcileTrigger } from "./SyncReconcileTrigger";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { StepActions } from "../flow-form/flow-form-styles";

export function SyncTriggersStep({ model }: { model: SyncFlowFormModel }) {
  const {
    currentWorkspace,
    backfillFlow,
    backfillStarting,
    setBackfillStarting,
    backfillNotice,
    setBackfillNotice,
    isSubmitting,
    currentFlowId,
    isNewMode,
    watchScheduleEnabled,
    watchWebhookEnabled,
    watchBackfillScheduleEnabled,
    provisioning,
    provisionProviderLabel,
    existingFlowForStatus,
    isCdcCapableDest,
    handleFormSubmit,
  } = model;
  return (
    <Stack spacing={2}>
      {/* How the sync is doing, and a full read now. */}
      {!isNewMode && currentWorkspace?.id && currentFlowId && (
        <Stack
          direction="row"
          spacing={2}
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <SyncStatusLine
            workspaceId={currentWorkspace.id}
            flowId={currentFlowId}
            poll={Boolean(
              existingFlowForStatus?.schedule?.enabled &&
              existingFlowForStatus?.schedule?.cron,
            )}
            webhook={Boolean(
              existingFlowForStatus?.webhookConfig?.enabled &&
              existingFlowForStatus?.webhookConfig?.endpoint,
            )}
            resync={Boolean(existingFlowForStatus?.backfillSchedule?.enabled)}
            lastPollAt={existingFlowForStatus?.lastRunAt}
            lastResyncAt={existingFlowForStatus?.backfillSchedule?.lastRunAt}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={backfillStarting}
            onClick={async () => {
              setBackfillStarting(true);
              setBackfillNotice(null);
              try {
                await backfillFlow(currentWorkspace.id, currentFlowId);
                // backfillFlow reports failures in the store,
                // it does not throw.
                const failed =
                  useFlowStore.getState().error[currentWorkspace.id];
                setBackfillNotice(
                  failed
                    ? `Backfill not started: ${failed}`
                    : "Backfill started: every record is read again.",
                );
              } catch (e) {
                setBackfillNotice(e instanceof Error ? e.message : String(e));
              } finally {
                setBackfillStarting(false);
              }
            }}
          >
            {backfillStarting ? "Starting…" : "Backfill now"}
          </Button>
        </Stack>
      )}
      {backfillNotice && (
        <Alert severity="info" onClose={() => setBackfillNotice(null)}>
          {backfillNotice}
        </Alert>
      )}
      {!watchScheduleEnabled &&
        !watchWebhookEnabled &&
        !(isCdcCapableDest && watchBackfillScheduleEnabled) && (
          <Alert severity="info">
            No automatic triggers are enabled. You can still run this sync
            manually.
          </Alert>
        )}

      {/* Live updates: polling and webhooks. Polling runs
          whenever it is on; webhooks only add speed on top. */}
      <Box>
        <Typography variant="subtitle1">Live updates</Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          Polling keeps running when webhooks are on: webhooks only make changes
          arrive sooner, and the full resync repairs whatever both miss.
        </Typography>
      </Box>
      <SyncScheduleTrigger model={model} />

      <SyncWebhookTrigger model={model} />

      <SyncReconcileTrigger model={model} />

      {isNewMode ? (
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleFormSubmit}
          disabled={isSubmitting}
          fullWidth
        >
          {isSubmitting
            ? "Creating..."
            : watchWebhookEnabled && provisioning?.supported
              ? `Create Sync & connect ${provisionProviderLabel}`
              : "Create Sync"}
        </Button>
      ) : (
        <StepActions>
          <Button
            variant="contained"
            onClick={handleFormSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Saving..." : "Save triggers"}
          </Button>
        </StepActions>
      )}
    </Stack>
  );
}
