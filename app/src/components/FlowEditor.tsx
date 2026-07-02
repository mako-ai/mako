import { useState, type RefObject } from "react";
import { Alert, Box, Tab, Tabs } from "@mui/material";
import { ScheduledFlowForm } from "./ScheduledFlowForm";
import { WebhookFlowForm } from "./WebhookFlowForm";
import { SyncFlowForm } from "./SyncFlowForm";
import { DbFlowForm, type DbFlowFormRef } from "./DbFlowForm";
import { FlowLogs } from "./FlowLogs";
import { BackfillPanel } from "./BackfillPanel";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useFeatureStore, selectUnifiedSyncFlows } from "../store/featureStore";

interface FlowEditorProps {
  flowId?: string;
  isNew?: boolean;
  flowType?: "scheduled" | "webhook" | "db-scheduled" | "sync"; // For new flows, specify the type
  onSave?: () => void;
  onCancel?: () => void;
  dbFlowFormRef?: RefObject<DbFlowFormRef | null>;
}

interface FlowSavedOptions {
  showBackfillPanel?: boolean;
  notice?: string;
}

export function FlowEditor({
  flowId,
  isNew = false,
  flowType = "scheduled",
  onSave,
  onCancel,
  dbFlowFormRef,
}: FlowEditorProps) {
  const [isEditing, setIsEditing] = useState(isNew);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null);
  // Unified builder: the Source step lets the user switch to a DB-query sync.
  const [dbSyncMode, setDbSyncMode] = useState(false);
  const [viewTab, setViewTab] = useState<"cdc" | "runs">("cdc");

  const { currentWorkspace } = useWorkspace();
  const { flows: flowsMap, runFlow } = useFlowStore();
  const unifiedSyncFlows = useFeatureStore(selectUnifiedSyncFlows);

  // Get flow details and derive webhook status
  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const currentFlow = currentFlowId
    ? flows.find(f => f._id === currentFlowId)
    : null;

  const isNewMode = Boolean(isNew && !currentFlowId);

  // Determine flow type - for new flows, use the prop; for existing, check the flow
  const isWebhookFlow =
    currentFlow?.type === "webhook" || (!currentFlow && flowType === "webhook");

  // Check if this is a database-to-database flow
  const isDbFlow =
    currentFlow?.sourceType === "database" ||
    (!currentFlow && (flowType === "db-scheduled" || dbSyncMode));

  // Unified builder covers every connector-source sync (scheduled, webhook,
  // hybrid); database-query sources keep the dedicated DbFlowForm.
  const useUnifiedForm = unifiedSyncFlows && !isDbFlow;

  const isCdcFlow = currentFlow?.syncEngine === "cdc";
  const hasScheduleTrigger = Boolean(
    currentFlow?.schedule?.enabled && currentFlow?.schedule?.cron,
  );

  const handleSaved = (newFlowId: string, options?: FlowSavedOptions) => {
    setCurrentFlowId(newFlowId);
    if (options?.showBackfillPanel) {
      setBackfillNotice(options.notice ?? null);
      setViewTab("cdc");
      setIsEditing(false);
      onSave?.();
      return;
    }

    setBackfillNotice(null);
    // Webhook flows stay in editing mode after first save so the user
    // can see the generated webhook URL and finish setup.
    if (!isWebhookFlow && !useUnifiedForm) {
      setIsEditing(false);
    }
    onSave?.();
  };

  const handleRunNow = async () => {
    if (currentWorkspace?.id && currentFlowId) {
      await runFlow(currentWorkspace.id, currentFlowId);
    }
  };

  const handleEditClick = () => {
    setBackfillNotice(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (isNewMode) {
      // For new flows, use the onCancel callback to close the editor
      onCancel?.();
    } else {
      // For existing flows, just go back to info view
      setIsEditing(false);
    }
  };

  // Post-save view. Unified model: the panel is keyed on the ENGINE, not the
  // flow type — scheduled CDC flows get the CDC pipeline dashboard too, with
  // a Run History tab when a poll schedule exists.
  const renderInfoView = () => {
    if (!currentFlowId) return null;

    if (unifiedSyncFlows) {
      if (!isCdcFlow) {
        return (
          <FlowLogs
            flowId={currentFlowId}
            onRunNow={handleRunNow}
            onEdit={handleEditClick}
          />
        );
      }
      if (!currentWorkspace) return null;
      const showRunsTab = hasScheduleTrigger;
      return (
        <>
          {backfillNotice && (
            <Alert
              severity="success"
              onClose={() => setBackfillNotice(null)}
              sx={{ m: 2, mb: 0 }}
            >
              {backfillNotice}
            </Alert>
          )}
          {showRunsTab && (
            <Tabs
              value={viewTab}
              onChange={(_e, value) => setViewTab(value)}
              sx={{ borderBottom: 1, borderColor: "divider", minHeight: 36 }}
            >
              <Tab label="CDC Pipeline" value="cdc" sx={{ minHeight: 36 }} />
              <Tab label="Run History" value="runs" sx={{ minHeight: 36 }} />
            </Tabs>
          )}
          {showRunsTab && viewTab === "runs" ? (
            <FlowLogs
              flowId={currentFlowId}
              onRunNow={handleRunNow}
              onEdit={handleEditClick}
            />
          ) : (
            <BackfillPanel
              workspaceId={currentWorkspace.id}
              flowId={currentFlowId}
              onEdit={handleEditClick}
            />
          )}
        </>
      );
    }

    // Legacy behavior: panel keyed on flow type.
    return (
      <>
        {!isWebhookFlow && (
          <FlowLogs
            flowId={currentFlowId}
            onRunNow={handleRunNow}
            onEdit={handleEditClick}
          />
        )}
        {isWebhookFlow && currentWorkspace && (
          <>
            {backfillNotice && (
              <Alert
                severity="success"
                onClose={() => setBackfillNotice(null)}
                sx={{ m: 2, mb: 0 }}
              >
                {backfillNotice}
              </Alert>
            )}
            <BackfillPanel
              workspaceId={currentWorkspace.id}
              flowId={currentFlowId}
              onEdit={handleEditClick}
            />
          </>
        )}
      </>
    );
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Show form when editing or creating new */}
      {isEditing ? (
        isDbFlow ? (
          <DbFlowForm
            ref={dbFlowFormRef as React.Ref<DbFlowFormRef>}
            flowId={currentFlowId}
            isNew={isNewMode}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        ) : useUnifiedForm ? (
          <SyncFlowForm
            flowId={currentFlowId}
            isNew={isNewMode}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
            onSwitchToDbSync={isNewMode ? () => setDbSyncMode(true) : undefined}
          />
        ) : isWebhookFlow ? (
          <WebhookFlowForm
            flowId={currentFlowId}
            isNew={isNewMode}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        ) : (
          <ScheduledFlowForm
            flowId={currentFlowId}
            isNew={isNewMode}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        )
      ) : (
        renderInfoView()
      )}
    </Box>
  );
}
