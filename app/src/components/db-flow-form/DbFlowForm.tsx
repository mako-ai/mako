import { forwardRef } from "react";
import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import { FlowFormTopBar } from "../flow-form/FlowFormTopBar";
import { FlowStep } from "../flow-form/FlowStep";
import {
  STEPS,
  type DbFlowFormProps,
  type DbFlowFormRef,
} from "./db-flow-config";
import { useDbFlowForm } from "./useDbFlowForm";
import { DbSourceStep } from "./DbSourceStep";
import { DbDestinationStep } from "./DbDestinationStep";
import { DbSchemaMappingStep } from "./DbSchemaMappingStep";
import { DbSyncModeStep } from "./DbSyncModeStep";
import { DbScheduleStep } from "./DbScheduleStep";
import {
  FlowFormColumn,
  FlowFormRoot,
  FlowFormScroll,
} from "../flow-form/flow-form-styles";

export const DbFlowForm = forwardRef<DbFlowFormRef, DbFlowFormProps>(
  function DbFlowForm(props, ref) {
    const model = useDbFlowForm(props, ref);
    const {
      onCancel,
      isNewMode,
      currentFlowId,
      isSubmitting,
      canSave,
      error,
      storeError,
      isLoadingFlow,
      openSteps,
      toggleStep,
      handleSubmit,
      onSubmit,
      handleDelete,
    } = model;
    const stepProps = (index: number) => ({
      index,
      step: STEPS[index],
      expanded: openSteps.has(index),
      onToggle: () => toggleStep(index),
    });

    return (
      <FlowFormRoot>
        <FlowFormTopBar
          isNew={isNewMode}
          isSubmitting={isSubmitting}
          onDelete={!isNewMode && currentFlowId ? handleDelete : undefined}
          onCancel={onCancel}
          onSave={handleSubmit(onSubmit)}
          saveDisabled={!canSave}
        />

        <FlowFormScroll>
          <FlowFormColumn>
            {(error || storeError) && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error || storeError}
              </Alert>
            )}

            {isLoadingFlow && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  py: 8,
                }}
              >
                <CircularProgress size={32} sx={{ mr: 2 }} />
                <Typography sx={{ color: "text.secondary" }}>
                  Loading flow configuration...
                </Typography>
              </Box>
            )}

            {!isLoadingFlow && (
              <form onSubmit={handleSubmit(onSubmit)}>
                <FlowStep {...stepProps(0)}>
                  <DbSourceStep model={model} />
                </FlowStep>
                <FlowStep {...stepProps(1)}>
                  <DbDestinationStep model={model} />
                </FlowStep>
                <FlowStep {...stepProps(2)}>
                  <DbSchemaMappingStep model={model} />
                </FlowStep>
                <FlowStep {...stepProps(3)}>
                  <DbSyncModeStep model={model} />
                </FlowStep>
                <FlowStep {...stepProps(4)}>
                  <DbScheduleStep model={model} />
                </FlowStep>
              </form>
            )}
          </FlowFormColumn>
        </FlowFormScroll>
      </FlowFormRoot>
    );
  },
);
