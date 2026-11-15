import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import { Close as CloseIcon } from "@mui/icons-material";
import ConflictResolutionDialog from "../ConflictResolutionDialog";
import EntityHistoryPopover from "../EntityHistoryPopover";
import FileExplorerDialog from "../FileExplorerDialog";
import { SaveCommentDialog } from "../SaveCommentDialog";
import VersionConflictDialog from "../VersionConflictDialog";
import { useConsoleStore } from "../../store/consoleStore";
import type { useWorkspace } from "../../contexts/workspace-context";
import type { ConsoleTab } from "../../store/lib/types";
import type { Connection } from "../../store/schemaStore";
import { saveDialogDefaultName } from "./editor-results";
import { ScheduleConsoleModal, ShareDialog } from "./lazy-tabs";
import type { useConsoleRuns } from "./hooks/useConsoleRuns";
import type { useConsoleSave } from "./hooks/useConsoleSave";
import type { useEditorFeedback } from "./hooks/useEditorFeedback";

interface EditorErrorDialogProps {
  open: boolean;
  message: string;
  onClose: () => void;
  /** Admin-only "Execute anyway" for a PREVIEW_BLOCKED query. */
  onExecuteAnyway?: () => void;
}

function EditorErrorDialog({
  open,
  message,
  onClose,
  onExecuteAnyway,
}: EditorErrorDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: { sx: { maxHeight: "80vh" } },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="h6" color="error">
          Operation Error
        </Typography>
        <IconButton aria-label="close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box component="pre" sx={{ p: 2, overflow: "auto" }}>
          {message}
        </Box>
      </DialogContent>
      <DialogActions>
        {onExecuteAnyway && (
          <Button
            onClick={onExecuteAnyway}
            color="error"
            variant="contained"
            disableElevation
          >
            Execute anyway
          </Button>
        )}
        <Button onClick={onClose} variant="contained" disableElevation>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface EditorDialogsProps {
  tabs: Record<string, ConsoleTab>;
  workspace: ReturnType<typeof useWorkspace>["currentWorkspace"];
  userId: string | undefined;
  isWorkspaceAdmin: boolean;
  availableDatabases: Connection[];
  feedback: ReturnType<typeof useEditorFeedback>;
  save: ReturnType<typeof useConsoleSave>;
  runs: ReturnType<typeof useConsoleRuns>;
  onExecuteAnyway: () => void;
  consoleHistory: { anchor: HTMLElement; tabId: string } | null;
  onCloseHistory: () => void;
  onHistoryRestored: (tabId: string) => void;
  shareConsoleTabId: string | null;
  onCloseShare: () => void;
}

/** Every modal surface the Editor owns (errors, saves, history, share, schedule). */
export function EditorDialogs({
  tabs,
  workspace,
  userId,
  isWorkspaceAdmin,
  availableDatabases,
  feedback,
  save,
  runs,
  onExecuteAnyway,
  consoleHistory,
  onCloseHistory,
  onHistoryRestored,
  shareConsoleTabId,
  onCloseShare,
}: EditorDialogsProps) {
  const shareConsoleTab = shareConsoleTabId
    ? tabs[shareConsoleTabId]
    : undefined;
  const scheduleModalTab = runs.scheduleModalTabId
    ? tabs[runs.scheduleModalTabId]
    : null;
  const scheduleModalHasSchedule = Boolean(
    scheduleModalTab?.schedule?.cron?.trim() &&
    scheduleModalTab?.schedule?.timezone?.trim(),
  );
  const saveDialogTab = save.saveDialogTabId
    ? tabs[save.saveDialogTabId]
    : undefined;

  return (
    <>
      <EditorErrorDialog
        open={feedback.errorModalOpen}
        message={feedback.errorMessage}
        onClose={feedback.closeError}
        onExecuteAnyway={
          isWorkspaceAdmin && feedback.errorPreviewRetry
            ? onExecuteAnyway
            : undefined
        }
      />

      {/* Conflict Resolution Dialog */}
      <ConflictResolutionDialog
        open={save.conflictDialogOpen}
        onClose={save.handleConflictClose}
        conflict={save.conflictData}
        newContent={save.pendingSaveContent}
        onOverwrite={save.handleConflictOverwrite}
        onSaveAsNew={save.handleConflictSaveAsNew}
        isProcessing={save.isSaving}
      />

      {/* Concurrent-edit (version) Conflict Dialog */}
      <VersionConflictDialog
        open={Boolean(save.versionConflictData)}
        onClose={save.handleVersionConflictClose}
        conflict={save.versionConflictData}
        newContent={save.pendingSaveContent}
        onOverwrite={save.handleVersionConflictOverwrite}
        onLoadLatest={save.handleVersionConflictLoadLatest}
        isProcessing={save.isSaving}
      />

      {/* Save Dialog (folder navigator) */}
      <FileExplorerDialog
        open={save.saveDialogOpen}
        onClose={save.handleSaveDialogClose}
        mode="save"
        onSave={save.handleSaveDialogConfirm}
        defaultName={saveDialogDefaultName(saveDialogTab, save.saveDialogMode)}
        initialSection={
          saveDialogTab?.access === "workspace" ? "workspace" : "my"
        }
        isSaving={save.isSaving}
      />

      {/* Save comment dialog (version commit message) */}
      <SaveCommentDialog
        open={save.commentDialogOpen}
        onSave={save.handleCommentSaveConfirm}
        onCancel={save.handleCommentSaveCancel}
        title="Save console version"
        defaultComment={save.saveSuggestion.comment}
        loading={save.saveSuggestion.loading}
        diff={save.saveSuggestion.diff}
      />

      {consoleHistory && workspace && (
        <EntityHistoryPopover
          anchorEl={consoleHistory.anchor}
          onClose={onCloseHistory}
          workspaceId={workspace.id}
          entity="console"
          id={consoleHistory.tabId}
          onRestored={() => onHistoryRestored(consoleHistory.tabId)}
        />
      )}

      {shareConsoleTab && (
        <ShareDialog
          open={!!shareConsoleTabId}
          onClose={onCloseShare}
          resourceType="console"
          resourceId={shareConsoleTab.id}
          resourceName={shareConsoleTab.title}
          ownerId={shareConsoleTab.owner_id}
          access={shareConsoleTab.access ?? "private"}
          workspaceRole={shareConsoleTab.workspaceRole ?? "viewer"}
          canManage={shareConsoleTab.owner_id === userId || isWorkspaceAdmin}
          onSharingChanged={changes => {
            if (changes.access && shareConsoleTabId) {
              useConsoleStore
                .getState()
                .updateAccess(shareConsoleTabId, changes.access);
            }
          }}
        />
      )}

      {scheduleModalTab && (
        <ScheduleConsoleModal
          open={Boolean(scheduleModalTab)}
          mode={runs.scheduleModalMode}
          initialName={scheduleModalTab.title}
          initialSchedule={scheduleModalTab.schedule}
          connectionLabel={
            availableDatabases.find(
              connection => connection.id === scheduleModalTab.connectionId,
            )?.displayName || scheduleModalTab.databaseName
          }
          workspaceId={workspace?.id}
          notificationConsoleId={
            scheduleModalTab.isSaved ? scheduleModalTab.id : undefined
          }
          workspaceRole={workspace?.role}
          onClose={runs.closeScheduleModal}
          onSave={runs.handleSaveSchedule}
          onRemove={
            runs.scheduleModalMode === "update" && scheduleModalHasSchedule
              ? async () => runs.handleRemoveSchedule(scheduleModalTab.id)
              : undefined
          }
          onRunNow={
            scheduleModalTab.isSaved
              ? async () => runs.handleRunScheduledNow(scheduleModalTab.id)
              : undefined
          }
        />
      )}
    </>
  );
}
