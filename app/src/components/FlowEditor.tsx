import { useEffect, useState, type RefObject } from "react";
import { useConsoleStore } from "../store/consoleStore";
import { Alert, Box, Tab, Tabs } from "@mui/material";
import { SyncFlowForm } from "./SyncFlowForm";
import { DbFlowForm, type DbFlowFormRef } from "./DbFlowForm";
import { FlowLogs } from "./FlowLogs";
import { BackfillPanel } from "./BackfillPanel";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { missingEntityError } from "../lib/entity-labels";

interface FlowEditorProps {
  /** The hosting tab, pinned when editing starts (preview-tab invariant). */
  tabId?: string;
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
  tabId,
  flowId,
  isNew = false,
  flowType = "sync",
  onSave,
  onCancel,
  dbFlowFormRef,
}: FlowEditorProps) {
  const [isEditing, setIsEditing] = useState(isNew);
  // Editing a flow (or creating one) is "modifying the content": pin the tab
  // so the next open cannot replace a half-filled form.
  useEffect(() => {
    if (isEditing && tabId) {
      useConsoleStore.getState().updateDirty(tabId, true);
    }
  }, [isEditing, tabId]);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null);
  // The Source step of the unified builder can switch to a DB-query sync.
  const [dbSyncMode, setDbSyncMode] = useState(false);
  const [viewTab, setViewTab] = useState<"cdc" | "runs">("cdc");

  const { currentWorkspace } = useWorkspace();
  const { flows: flowsMap, runFlow, fetchFlows } = useFlowStore();
  const flowsError = useFlowStore(s =>
    currentWorkspace ? s.error[currentWorkspace.id] : null,
  );
  // runFlow records its failure in the store and swallows it; nothing in
  // this view rendered that field once the flow resolved, so "Run Now" on a
  // flow the API rejects looked like nothing happened.
  const [actionError, setActionError] = useState<string | null>(null);

  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const currentFlow = currentFlowId
    ? flows.find(f => f._id === currentFlowId)
    : null;

  const isNewMode = Boolean(isNew && !currentFlowId);

  // Deep links can reference a flow that isn't in the (possibly stale) cached
  // list — e.g. after a workspace switch. Refetch once before deciding the
  // flow doesn't exist, so we never show "not found" for a merely-uncached
  // flow, and never leave the tab empty for a truly missing one.
  const [missingFlowVerified, setMissingFlowVerified] = useState(false);
  useEffect(() => {
    if (
      !currentWorkspace?.id ||
      isNewMode ||
      !currentFlowId ||
      currentFlow ||
      missingFlowVerified
    ) {
      return;
    }
    let cancelled = false;
    void fetchFlows(currentWorkspace.id).finally(() => {
      if (!cancelled) setMissingFlowVerified(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    currentWorkspace?.id,
    isNewMode,
    currentFlowId,
    currentFlow,
    missingFlowVerified,
    fetchFlows,
  ]);

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
      setActionError(null);
      const workspaceId = currentWorkspace.id;
      useFlowStore.setState(state => {
        state.error[workspaceId] = null;
      });
      await runFlow(workspaceId, currentFlowId);
      const failure = useFlowStore.getState().error[workspaceId];
      if (failure) setActionError(failure);
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

    const invalid = currentFlow?.definitionInvalid;
    const notices = (
      <>
        {invalid && (
          <Alert severity="warning" sx={{ m: 2, mb: 0 }}>
            The flow file in git is invalid ({invalid.reason}).
            {invalid.path ? (
              <>
                {" "}
                Fix <code>{invalid.path}</code> on main;
              </>
            ) : null}{" "}
            until then this shows the last valid version and its schedules are
            paused.
          </Alert>
        )}
        {actionError && (
          <Alert
            severity="error"
            onClose={() => setActionError(null)}
            sx={{ m: 2, mb: 0 }}
          >
            {actionError}
          </Alert>
        )}
      </>
    );

    if (!isCdcFlow) {
      return (
        <>
          {notices}
          <FlowLogs
            flowId={currentFlowId}
            onRunNow={handleRunNow}
            onEdit={handleEditClick}
          />
        </>
      );
    }
    if (!currentWorkspace) return null;
    const showRunsTab = hasScheduleTrigger;
    return (
      <>
        {notices}
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

  // Existing-flow tab whose flow can't be resolved: loading until the
  // verification fetch settles, then an explicit error / not-found state
  // (never a silently empty tab).
  if (!isEditing && !isNewMode && currentFlowId && !currentFlow) {
    if (!missingFlowVerified) {
      return <EntityLoadingState label="Loading flow…" />;
    }
    if (flowsError) {
      return (
        <EntityLoadErrorState
          error={{ message: flowsError }}
          entityLabel="flow"
          onRetry={() => setMissingFlowVerified(false)}
        />
      );
    }
    return (
      <EntityLoadErrorState
        error={missingEntityError("flow")}
        entityLabel="flow"
      />
    );
  }

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
