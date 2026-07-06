import { useState, type RefObject } from "react";
import { Alert, Box, Tab, Tabs } from "@mui/material";
import { SyncFlowForm } from "./SyncFlowForm";
import { DbFlowForm, type DbFlowFormRef } from "./DbFlowForm";
import { FlowLogs } from "./FlowLogs";
import { BackfillPanel } from "./BackfillPanel";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";

interface FlowEditorProps {
  flowId?: string;
  isNew?: boolean;
  /**
   * For new flows: "db-scheduled" opens the database-query sync form;
   * everything else opens the unified Sync builder. Legacy tab metadata
   * ("scheduled" / "webhook") from previously-opened tabs maps to the
   * unified builder too.
   */
  flowType?: "scheduled" | "webhook" | "db-scheduled" | "sync";
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
  flowType = "sync",
  onSave,
  onCancel,
  dbFlowFormRef,
}: FlowEditorProps) {
  const [isEditing, setIsEditing] = useState(isNew);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null);
  // The Source step of the unified builder can switch to a DB-query sync.
  const [dbSyncMode, setDbSyncMode] = useState(false);
  const [viewTab, setViewTab] = useState<"cdc" | "runs">("cdc");

  const { currentWorkspace } = useWorkspace();
  const { flows: flowsMap, runFlow } = useFlowStore();

  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const currentFlow = currentFlowId
    ? flows.find(f => f._id === currentFlowId)
    : null;

  const isNewMode = Boolean(isNew && !currentFlowId);

  // Database-query sources keep the dedicated DbFlowForm.
  const isDbFlow =
    currentFlow?.sourceType === "database" ||
    (!currentFlow && (flowType === "db-scheduled" || dbSyncMode));

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
    // The unified builder stays in editing mode after the first save so the
    // user can finish webhook setup (URL/secret) when that trigger is on.
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
      onCancel?.();
    } else {
      setIsEditing(false);
    }
  };

  // Post-save view, keyed on the ENGINE: CDC flows get the pipeline
  // dashboard (with a Run History tab when a poll schedule exists); legacy
  // flows get the plain run history.
  const renderInfoView = () => {
    if (!currentFlowId) return null;

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
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
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
        ) : (
          <SyncFlowForm
            flowId={currentFlowId}
            isNew={isNewMode}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
            onSwitchToDbSync={isNewMode ? () => setDbSyncMode(true) : undefined}
          />
        )
      ) : (
        renderInfoView()
      )}
    </Box>
  );
}
