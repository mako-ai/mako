import { Alert, Button, Stack } from "@mui/material";
import { NavigateNext as NextIcon } from "@mui/icons-material";
import { FlowRunNotificationsSection } from "../FlowRunNotificationsSection";
import { SyncQueriesSection } from "./SyncQueriesSection";
import { SyncEntityTable } from "./SyncEntityTable";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { StepActions } from "../flow-form/flow-form-styles";

export function SyncEntitiesStep({ model }: { model: SyncFlowFormModel }) {
  const {
    currentWorkspace,
    currentFlowId,
    openNextStep,
    watchDataSourceId,
    watchEntityLayouts,
    hasTransferQueries,
  } = model;
  return (
    <Stack spacing={3}>
      <SyncQueriesSection model={model} />

      <SyncEntityTable model={model} />

      {!hasTransferQueries &&
        watchEntityLayouts.length === 0 &&
        watchDataSourceId && (
          <Alert severity="info">Loading entities for this connector…</Alert>
        )}

      {currentWorkspace && (
        <FlowRunNotificationsSection
          workspaceId={currentWorkspace.id}
          resourceType="flow"
          resourceId={currentFlowId ?? undefined}
          workspaceRole={currentWorkspace.role}
        />
      )}

      <StepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(3)}
        >
          Continue to Triggers
        </Button>
      </StepActions>
    </Stack>
  );
}
