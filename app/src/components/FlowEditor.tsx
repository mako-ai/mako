import { useState } from "react";
import { Box } from "@mui/material";
import { ScheduledFlowForm } from "./ScheduledFlowForm";
import { WebhookFlowForm } from "./WebhookFlowForm";
import { FlowLogs } from "./FlowLogs";
import { WebhookStats } from "./WebhookStats";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";

interface FlowEditorProps {
  flowId?: string;
  isNew?: boolean;
  flowType?: "scheduled" | "webhook"; // For new flows, specify the type
  onSave?: () => void;
  onCancel?: () => void;
}

export function FlowEditor({
  flowId,
  isNew = false,
  flowType = "scheduled",
  onSave,
  onCancel,
}: FlowEditorProps) {
  const [isEditing, setIsEditing] = useState(isNew);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const { currentWorkspace } = useWorkspace();
  const { flows: flowsMap, runFlow } = useFlowStore();

  // Get flow details and derive webhook status
  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const currentFlow = currentFlowId
    ? flows.find(f => f._id === currentFlowId)
    : null;

  // Determine if this is a webhook flow - for new flows, use the prop; for existing, check the flow
  const isWebhookFlow = isNew
    ? flowType === "webhook"
    : currentFlow?.type === "webhook";

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
            <WebhookStats
              workspaceId={currentWorkspace.id}
              flowId={currentFlowId}
              onEdit={handleEditClick}
            />
          )}
        </>
      )}
    </Box>
  );
}

/** @deprecated Use FlowEditor instead */
export const SyncJobEditor = FlowEditor;

