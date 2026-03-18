import { useState, type RefObject } from "react";
import { Box, Tabs, Tab } from "@mui/material";
import { ScheduledFlowForm } from "./ScheduledFlowForm";
import { WebhookFlowForm } from "./WebhookFlowForm";
import { DbFlowForm, type DbFlowFormRef } from "./DbFlowForm";
import { FlowLogs } from "./FlowLogs";
import { WebhookStats } from "./WebhookStats";
import { BackfillPanel } from "./BackfillPanel";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";

interface FlowEditorProps {
  flowId?: string;
  isNew?: boolean;
  flowType?: "scheduled" | "webhook" | "db-scheduled"; // For new flows, specify the type
  onSave?: () => void;
  onCancel?: () => void;
  dbFlowFormRef?: RefObject<DbFlowFormRef | null>;
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
  const [webhookTab, setWebhookTab] = useState(0);
  const { currentWorkspace } = useWorkspace();
  const { flows: flowsMap, runFlow } = useFlowStore();

  // Get flow details and derive webhook status
  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const currentFlow = currentFlowId
    ? flows.find(f => f._id === currentFlowId)
    : null;

  // Determine flow type - for new flows, use the prop; for existing, check the flow
  const isWebhookFlow = isNew
    ? flowType === "webhook"
    : currentFlow?.type === "webhook";
  const isCdcFlow = !isNew && currentFlow?.syncEngine === "cdc";

  // Check if this is a database-to-database flow
  const isDbFlow = isNew
    ? flowType === "db-scheduled"
    : currentFlow?.sourceType === "database";

  const handleSaved = (newFlowId: string) => {
    setCurrentFlowId(newFlowId);
    // Switch to info view after saving
    setIsEditing(false);
    onSave?.();
  };

  const handleRunNow = async () => {
    if (currentWorkspace?.id && currentFlowId) {
      await runFlow(currentWorkspace.id, currentFlowId);
    }
  };

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (isNew && !currentFlowId) {
      // For new flows, use the onCancel callback to close the editor
      onCancel?.();
    } else {
      // For existing flows, just go back to info view
      setIsEditing(false);
    }
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
        isWebhookFlow ? (
          <WebhookFlowForm
            flowId={currentFlowId}
            isNew={isNew && !currentFlowId}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        ) : isDbFlow ? (
          <DbFlowForm
            ref={dbFlowFormRef as React.Ref<DbFlowFormRef>}
            flowId={currentFlowId}
            isNew={isNew && !currentFlowId}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        ) : (
          <ScheduledFlowForm
            flowId={currentFlowId}
            isNew={isNew && !currentFlowId}
            onSave={onSave}
            onSaved={handleSaved}
            onCancel={handleCancelEdit}
          />
        )
      ) : (
        /* Show info/logs when not editing */
        <>
          {currentFlowId && !isWebhookFlow && (
            <FlowLogs
              flowId={currentFlowId}
              onRunNow={handleRunNow}
              onEdit={handleEditClick}
            />
          )}
          {currentFlowId && isWebhookFlow && currentWorkspace && (
            isCdcFlow ? (
              <BackfillPanel
                workspaceId={currentWorkspace.id}
                flowId={currentFlowId}
              />
            ) : (
              <Box
                sx={{ height: "100%", display: "flex", flexDirection: "column" }}
              >
                <Tabs
                  value={webhookTab}
                  onChange={(_, v) => setWebhookTab(v)}
                  sx={{ borderBottom: 1, borderColor: "divider", minHeight: 36 }}
                >
                  <Tab label="Webhook Events" sx={{ minHeight: 36, py: 0.5 }} />
                  <Tab label="Backfill" sx={{ minHeight: 36, py: 0.5 }} />
                </Tabs>
                <Box sx={{ flex: 1, overflow: "hidden" }}>
                  {webhookTab === 0 && (
                    <WebhookStats
                      workspaceId={currentWorkspace.id}
                      flowId={currentFlowId}
                      onEdit={handleEditClick}
                    />
                  )}
                  {webhookTab === 1 && (
                    <BackfillPanel
                      workspaceId={currentWorkspace.id}
                      flowId={currentFlowId}
                    />
                  )}
                </Box>
              </Box>
            )
          )}
        </>
      )}
    </Box>
  );
}
