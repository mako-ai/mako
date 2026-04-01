import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useDashboardStore,
  selectDashboard,
  selectSavedHash,
  type DashboardConflict,
} from "../store/dashboardStore";
import { computeDashboardStateHash } from "../utils/stateHash";

const {
  enterEditMode: enterEditModeAction,
  exitEditMode: exitEditModeAction,
  heartbeatLock: heartbeatLockAction,
  resolveConflict: resolveConflictAction,
} = useDashboardStore.getState();

interface UseDashboardEditSessionOptions {
  dashboardId?: string;
  workspaceId?: string;
}

interface UseDashboardEditSessionResult {
  isStoreEditMode: boolean;
  isEditMode: boolean;
  isReadOnly: boolean;
  hasUnsavedChanges: boolean;
  historyIndex: number;
  historyLength: number;
  conflict: DashboardConflict | null;
  lockError: string | null;
  exitEditConfirmOpen: boolean;
  handleEditModeToggle: (mode: "edit" | "view") => Promise<void>;
  handleForceEditMode: () => Promise<void>;
  handleExitEditSave: () => Promise<void>;
  handleExitEditDiscard: () => Promise<void>;
  handleExitEditCancel: () => void;
  setLockError: (error: string | null) => void;
  resolveConflictAction: typeof resolveConflictAction;
}

export function useDashboardEditSession({
  dashboardId,
  workspaceId,
}: UseDashboardEditSessionOptions): UseDashboardEditSessionResult {
  const { isStoreEditMode, historyEntry, conflict, isReadOnly } =
    useDashboardStore(
      useShallow(state => {
        const dashboard = dashboardId
          ? state.openDashboards[dashboardId]
          : undefined;
        return {
          isStoreEditMode: dashboardId
            ? (state.editingDashboards[dashboardId] ?? false)
            : false,
          historyEntry: dashboardId ? state.historyMap[dashboardId] : undefined,
          conflict:
            state.conflict?.dashboardId === dashboardId ? state.conflict : null,
          isReadOnly: dashboard?.readOnly === true,
        };
      }),
    );

  const dashboardSelector = useMemo(
    () => selectDashboard(dashboardId),
    [dashboardId],
  );
  const savedHashSelector = useMemo(
    () => selectSavedHash(dashboardId),
    [dashboardId],
  );
  const dashboard = useDashboardStore(dashboardSelector);
  const savedHash = useDashboardStore(savedHashSelector);
  const hasUnsavedChanges = useMemo(() => {
    if (!dashboard) return false;
    if (!savedHash) return true;
    return computeDashboardStateHash(dashboard) !== savedHash;
  }, [dashboard, savedHash]);

  const [lockError, setLockError] = useState<string | null>(null);
  const [exitEditConfirmOpen, setExitEditConfirmOpen] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const historyIndex = historyEntry?.index ?? -1;
  const historyLength = historyEntry?.stack.length ?? 0;
  const isEditMode = isStoreEditMode && !isReadOnly;

  const handleForceEditMode = useCallback(async () => {
    if (!workspaceId || !dashboardId) return;
    setLockError(null);
    const result = await enterEditModeAction(workspaceId, dashboardId, {
      force: true,
    });
    if (!result.ok) {
      setLockError("Failed to acquire edit lock. Please try again.");
    }
  }, [workspaceId, dashboardId]);

  const handleEditModeToggle = useCallback(
    async (mode: "edit" | "view") => {
      if (!workspaceId || !dashboardId) return;
      setLockError(null);

      if (mode === "edit") {
        const result = await enterEditModeAction(workspaceId, dashboardId);
        if (!result.ok) {
          if (result.lockedBy) {
            setLockError(
              `${result.lockedBy} is currently editing this dashboard`,
            );
          } else {
            setLockError("Failed to acquire edit lock. Please try again.");
          }
        }
      } else {
        const store = useDashboardStore.getState();
        const dash = store.openDashboards[dashboardId];
        const savedHash = store.savedStateHashes[dashboardId];
        if (
          dash &&
          savedHash !== undefined &&
          computeDashboardStateHash(dash) !== savedHash
        ) {
          setExitEditConfirmOpen(true);
          return;
        }
        void exitEditModeAction(workspaceId, dashboardId);
      }
    },
    [workspaceId, dashboardId],
  );

  const handleExitEditSave = useCallback(async () => {
    if (!workspaceId || !dashboardId) return;
    setExitEditConfirmOpen(false);
    const saved = await useDashboardStore
      .getState()
      .saveDashboard(workspaceId, dashboardId);
    if (saved) {
      void exitEditModeAction(workspaceId, dashboardId);
    }
  }, [workspaceId, dashboardId]);

  const handleExitEditDiscard = useCallback(async () => {
    if (!workspaceId || !dashboardId) return;
    setExitEditConfirmOpen(false);
    await exitEditModeAction(workspaceId, dashboardId);
    await useDashboardStore
      .getState()
      .reloadDashboard(workspaceId, dashboardId);
  }, [workspaceId, dashboardId]);

  const handleExitEditCancel = useCallback(() => {
    setExitEditConfirmOpen(false);
  }, []);

  // Heartbeat to keep lock alive while editing
  useEffect(() => {
    if (isStoreEditMode && workspaceId && dashboardId) {
      heartbeatRef.current = setInterval(() => {
        heartbeatLockAction(workspaceId, dashboardId);
      }, 30_000);
    }
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [isStoreEditMode, workspaceId, dashboardId]);

  return {
    isStoreEditMode,
    isEditMode,
    isReadOnly,
    hasUnsavedChanges,
    historyIndex,
    historyLength,
    conflict,
    lockError,
    exitEditConfirmOpen,
    handleEditModeToggle,
    handleForceEditMode,
    handleExitEditSave,
    handleExitEditDiscard,
    handleExitEditCancel,
    setLockError,
    resolveConflictAction,
  };
}
