import { Alert, Box, Typography } from "@mui/material";
import { FlowFormTopBar } from "../flow-form/FlowFormTopBar";
import { FlowStep } from "../flow-form/FlowStep";
import { STEPS, type SyncFlowFormProps } from "./sync-flow-config";
import { useSyncFlowForm } from "./useSyncFlowForm";
import { LayoutResetDialog } from "./LayoutResetDialog";
import { SyncSourceStep } from "./SyncSourceStep";
import { SyncDestinationStep } from "./SyncDestinationStep";
import { SyncConfigStep } from "./SyncConfigStep";
import { SyncEntitiesStep } from "./SyncEntitiesStep";
import { SyncTriggersStep } from "./SyncTriggersStep";

/**
 * Unified Sync builder.
 *
 * Replaces the ScheduledFlowForm / WebhookFlowForm split: the trigger set
 * (scheduled poll and/or webhook push) is a property of one Sync, chosen in
 * the last step, instead of a flow "type" picked up-front. Composed from the proven
 * pieces of both legacy forms (destination + schema/prefix, entity layout
 * table, webhook secret/provisioning block, cron presets).
 */
export function SyncFlowForm(props: SyncFlowFormProps) {
  const model = useSyncFlowForm(props);
  const {
    onCancel,
    isNewMode,
    currentFlowId,
    isSubmitting,
    error,
    storeError,
    openSteps,
    toggleStep,
    stepHasError,
    pinTriggersOpen,
    isProvisioningWebhook,
    handleFormSubmit,
    handleDelete,
  } = model;
  const stepProps = (index: number) => ({
    index,
    step: STEPS[index],
    expanded: openSteps.has(index),
    onToggle: () => toggleStep(index),
    hasError: stepHasError(index),
  });

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <LayoutResetDialog model={model} />

      <FlowFormTopBar
        isNew={isNewMode}
        isSubmitting={isSubmitting}
        onDelete={!isNewMode && currentFlowId ? handleDelete : undefined}
        onCancel={onCancel}
        onSave={handleFormSubmit}
      />

      <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, sm: 3 } }}>
        <Box sx={{ maxWidth: "800px", mx: "auto" }}>
          {(error || storeError) && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error || storeError}
            </Alert>
          )}

          {currentFlowId && (
            <Typography variant="body1" sx={{ mb: 2 }}>
              <strong>Sync ID:</strong> {currentFlowId}
            </Typography>
          )}

          <form onSubmit={handleFormSubmit}>
            <FlowStep {...stepProps(0)}>
              <SyncSourceStep model={model} />
            </FlowStep>
            <FlowStep {...stepProps(1)}>
              <SyncDestinationStep model={model} />
            </FlowStep>
            <FlowStep {...stepProps(2)}>
              <SyncConfigStep model={model} />
            </FlowStep>
            <FlowStep {...stepProps(3)}>
              <SyncEntitiesStep model={model} />
            </FlowStep>
            <FlowStep
              {...stepProps(4)}
              expanded={
                openSteps.has(4) || pinTriggersOpen || isProvisioningWebhook
              }
            >
              <SyncTriggersStep model={model} />
            </FlowStep>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
