import { useState } from "react";
import { useConsoleStore } from "../../../store/consoleStore";
import type { MakoChartSpec } from "../../../lib/chart-spec";
import type { ConsoleVersionConflict } from "../../../lib/api-types";
import type { ConflictData } from "../../ConflictResolutionDialog";
import type { ConsoleRef } from "../../Console";
import { useConfirm } from "../../ConfirmDialog";
import { useSaveCommentSuggestion } from "../../../hooks/useSaveCommentSuggestion";
import { trackEvent } from "../../../lib/analytics";
import { consoleLeafName } from "../../../lib/console-name";
import { generateObjectId } from "../../../utils/objectId";
import { computeConsoleStateHash } from "../../../utils/stateHash";
import type { ResultsViewMode, SaveDialogMode } from "../types";
import type { EditorFeedback } from "./useEditorFeedback";
import { useStableCallback } from "./useStableCallback";

type Access = "private" | "workspace";

interface PendingSave {
  tabId: string;
  content: string;
  path: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  comment?: string;
  access?: Access;
}

interface UseConsoleSaveArgs {
  workspaceId: string | undefined;
  tabChartSpecs: Record<string, MakoChartSpec | null>;
  tabViewModes: Record<string, ResultsViewMode>;
  getConsoleRef: (tabId: string) => React.RefObject<ConsoleRef | null>;
  feedback: EditorFeedback;
  /** Opens the schedule modal (a save can carry `openScheduleOnSave`). */
  openScheduleModal: (tabId: string, mode: "create" | "update") => void;
}

const sectionAccess = (section: "my" | "workspace"): Access =>
  section === "workspace" ? "workspace" : "private";

async function addToConsoleTree(workspaceId: string, path: string, id: string) {
  const { useConsoleTreeStore } =
    await import("../../../store/consoleTreeStore");
  useConsoleTreeStore.getState().addConsole(workspaceId, path, id);
}

async function refreshConsoleTree(workspaceId: string) {
  const { useConsoleTreeStore } =
    await import("../../../store/consoleTreeStore");
  useConsoleTreeStore.getState().refresh(workspaceId);
}

/**
 * Every console save flow: save with a version comment, first-time save /
 * save-a-copy / rename-move through the folder dialog, and the two conflict
 * resolutions (path conflict, concurrent-edit version conflict).
 */
export function useConsoleSave({
  workspaceId,
  tabChartSpecs,
  tabViewModes,
  getConsoleRef,
  feedback,
  openScheduleModal,
}: UseConsoleSaveArgs) {
  const confirm = useConfirm();
  const saveSuggestion = useSaveCommentSuggestion();
  const closeTab = useConsoleStore(state => state.closeTab);
  const updateContent = useConsoleStore(state => state.updateContent);
  const updateFilePath = useConsoleStore(state => state.updateFilePath);
  const updateAccess = useConsoleStore(state => state.updateAccess);
  const updateTitle = useConsoleStore(state => state.updateTitle);
  const updateDirty = useConsoleStore(state => state.updateDirty);
  const updateSavedState = useConsoleStore(state => state.updateSavedState);
  const updateVersion = useConsoleStore(state => state.updateVersion);
  const getVersionManager = useConsoleStore(state => state.getVersionManager);
  const generateSaveComment = useConsoleStore(
    state => state.generateSaveComment,
  );
  const saveConsole = useConsoleStore(state => state.saveConsole);
  const deleteConsole = useConsoleStore(state => state.deleteConsole);

  const [isSaving, setIsSaving] = useState(false);

  // Save dialog state (folder navigator)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDialogTabId, setSaveDialogTabId] = useState<string | null>(null);
  const [saveDialogContent, setSaveDialogContent] = useState("");
  // Which flow opened the dialog:
  //   "new"           — first-time save of a draft tab (POST with the tab's own id)
  //   "save-as-copy"  — create a brand-new console record (POST with a fresh id),
  //                     leaving the current tab untouched.
  //   "rename-move"   — relocate an already-saved console (PUT via saveConsole)
  //                     to a new path; current tab updates to the new path.
  const [saveDialogMode, setSaveDialogMode] = useState<SaveDialogMode>("new");
  // Id that will be sent to the API. Same as saveDialogTabId for "new" and
  // "rename-move"; a freshly-generated id for "save-as-copy".
  const [saveDialogTargetId, setSaveDialogTargetId] = useState<string | null>(
    null,
  );

  // Save comment dialog state (version commit message)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [pendingCommentSave, setPendingCommentSave] = useState<{
    tabId: string;
    content: string;
    path: string;
    resolve: (success: boolean) => void;
  } | null>(null);

  // Conflict resolution state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictData, setConflictData] = useState<ConflictData | null>(null);

  // Concurrent-edit (optimistic concurrency) conflict state
  const [versionConflictData, setVersionConflictData] =
    useState<ConsoleVersionConflict | null>(null);

  const [pendingSaveData, setPendingSaveData] = useState<PendingSave | null>(
    null,
  );

  const { showError, showSnackbar } = feedback;

  const openSaveDialog = (
    mode: SaveDialogMode,
    tabId: string,
    targetId: string,
    content: string,
  ) => {
    setSaveDialogMode(mode);
    setSaveDialogTabId(tabId);
    setSaveDialogTargetId(targetId);
    setSaveDialogContent(content);
    setSaveDialogOpen(true);
  };

  const resetSaveDialog = () => {
    setSaveDialogTabId(null);
    setSaveDialogTargetId(null);
    setSaveDialogMode("new");
    setSaveDialogContent("");
  };

  /** Point a tab at its saved path and mark its current state as saved. */
  const markTabSaved = (
    tabId: string,
    path: string,
    access: Access | undefined,
    content: string,
    connectionId?: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    updateFilePath(tabId, path);
    updateTitle(tabId, consoleLeafName(path));
    updateAccess(tabId, access);
    updateDirty(tabId, true);
    // Update saved state (isSaved=true, new savedStateHash)
    updateSavedState(
      tabId,
      true,
      computeConsoleStateHash(content, connectionId, databaseId, databaseName),
    );
  };

  const showConflict = (pending: PendingSave, conflict: ConflictData) => {
    setPendingSaveData(pending);
    setConflictData(conflict);
    setConflictDialogOpen(true);
    setIsSaving(false);
  };

  const executeConsoleSave = async (
    tabId: string,
    contentToSave: string,
    savePath: string,
    comment: string,
  ): Promise<boolean> => {
    if (!workspaceId) return false;
    setIsSaving(true);
    let success = false;
    try {
      const currentTab = useConsoleStore.getState().tabs[tabId];
      const connectionId = currentTab?.connectionId;
      const databaseId = currentTab?.databaseId;
      const databaseName = currentTab?.databaseName;
      const pending: PendingSave = {
        tabId,
        content: contentToSave,
        path: savePath,
        connectionId,
        databaseId,
        databaseName,
        comment,
        access: currentTab?.access,
      };

      const result = await saveConsole(
        workspaceId,
        tabId,
        contentToSave,
        savePath,
        connectionId,
        databaseName,
        databaseId,
        tabChartSpecs[tabId] ?? undefined,
        tabViewModes[tabId],
        comment,
        currentTab?.access,
      );

      // Handle conflict - show resolution dialog
      if (result.error === "conflict" && result.conflict) {
        showConflict(pending, result.conflict);
        return false;
      }

      // Handle concurrent-edit conflict — someone else saved this console
      // since we loaded it. Show a diff so the user resolves it explicitly
      // instead of silently overwriting the other person's save.
      if (result.error === "version_conflict" && result.versionConflict) {
        setPendingSaveData(pending);
        setVersionConflictData(result.versionConflict);
        setIsSaving(false);
        return false;
      }

      if (result.success) {
        markTabSaved(
          tabId,
          savePath,
          currentTab?.access,
          contentToSave,
          connectionId,
          databaseId,
          databaseName,
        );

        trackEvent("console_saved", {
          console_id: tabId,
        });

        showSnackbar(`Console saved to '${savePath}.js'`);
        success = true;

        // Add the console to the tree
        if (!currentTab?.filePath) {
          await addToConsoleTree(workspaceId, savePath ?? "", tabId);
        }

        if (currentTab?.metadata?.openScheduleOnSave) {
          useConsoleStore.setState(state => {
            const tab = state.tabs[tabId];
            if (tab?.metadata) {
              delete tab.metadata.openScheduleOnSave;
            }
          });
          openScheduleModal(tabId, "create");
        }
      } else if (result.code === "github_required") {
        // Production gate (apps.md §17): saves live in the workspace's own
        // GitHub repo. Take the user straight to the connect screen.
        const state = useConsoleStore.getState();
        const existing = Object.values(state.tabs).find(
          t => t.kind === "settings" && t.settingsSection === "github",
        );
        if (existing) {
          state.setActiveTab(existing.id);
        } else {
          const id = state.openTab({
            title: "GitHub",
            content: "",
            kind: "settings",
            settingsSection: "github",
          });
          state.setActiveTab(id);
        }
        showSnackbar(
          "Connect a GitHub repository to save consoles — Mako keeps your work in your own repo.",
        );
      } else {
        showError(JSON.stringify(result.error, null, 2));
      }
    } catch (e: any) {
      showError(JSON.stringify(e, null, 2));
    } finally {
      setIsSaving(false);
    }
    return success;
  };

  const handleConsoleSave = useStableCallback(
    async (
      tabId: string,
      contentToSave: string,
      currentPath?: string,
    ): Promise<boolean> => {
      if (!workspaceId) {
        showError("No workspace selected");
        return false;
      }

      if (!currentPath) {
        openSaveDialog("new", tabId, tabId, contentToSave);
        return false;
      }

      // Comments already attached to recent AI edits win over a fresh
      // AI-generated suggestion (they carry the user's intent directly).
      const vm = getVersionManager(tabId);
      const aiComments = vm?.getRecentAiComments() ?? [];
      const existingComment =
        aiComments.length > 0 ? aiComments.join("; ") : undefined;

      saveSuggestion.begin(
        signal =>
          generateSaveComment(
            workspaceId,
            tabId,
            { newContent: contentToSave, source: "user" },
            signal,
          ),
        existingComment,
      );

      return new Promise<boolean>(resolve => {
        setPendingCommentSave({
          tabId,
          content: contentToSave,
          path: currentPath,
          resolve,
        });
        setCommentDialogOpen(true);
      });
    },
  );

  const handleCommentSaveConfirm = async (comment: string) => {
    setCommentDialogOpen(false);
    saveSuggestion.cancel();
    const pending = pendingCommentSave;
    setPendingCommentSave(null);
    if (!pending) return;
    const success = await executeConsoleSave(
      pending.tabId,
      pending.content,
      pending.path,
      comment,
    );
    pending.resolve(success);
  };

  const handleCommentSaveCancel = () => {
    setCommentDialogOpen(false);
    saveSuggestion.cancel();
    const pending = pendingCommentSave;
    setPendingCommentSave(null);
    pending?.resolve(false);
  };

  // Conflict resolution handlers
  const handleConflictOverwrite = async () => {
    if (!pendingSaveData || !workspaceId || !conflictData) return;

    const existingId = conflictData.existingId;

    // Check if the target console has an open tab
    const existingTab = useConsoleStore.getState().tabs[existingId];
    if (existingTab) {
      // Check if the existing tab has unsaved changes by comparing current state to saved state
      const existingHash = existingTab.savedStateHash;
      const currentHash = computeConsoleStateHash(
        existingTab.content,
        existingTab.connectionId,
        existingTab.databaseId,
        existingTab.databaseName,
      );
      const hasChanges = !existingHash || currentHash !== existingHash;

      if (hasChanges) {
        const confirmed = await confirm({
          title: "Overwrite with unsaved changes?",
          body: `The file "${existingTab.title || conflictData.existingName}" is open in another tab with unsaved changes. If you proceed, those unsaved changes will be lost. Do you want to continue with the overwrite?`,
          confirmLabel: "Overwrite",
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
      }
      // Close the existing tab since we're deleting that console
      closeTab(existingId);
    }

    setIsSaving(true);
    setConflictDialogOpen(false);

    try {
      // Step 1: Delete the existing console at the conflicting path
      const deleteResult = await deleteConsole(workspaceId, existingId);

      if (!deleteResult.success) {
        showError(deleteResult.error || "Failed to delete existing console");
        setIsSaving(false);
        setPendingSaveData(null);
        setConflictData(null);
        return;
      }

      // Step 2: Save our console with the path (same ID as before)
      const result = await saveConsole(
        workspaceId,
        pendingSaveData.tabId,
        pendingSaveData.content,
        pendingSaveData.path,
        pendingSaveData.connectionId,
        pendingSaveData.databaseName,
        pendingSaveData.databaseId,
        tabChartSpecs[pendingSaveData.tabId] ?? undefined,
        tabViewModes[pendingSaveData.tabId],
        pendingSaveData.comment,
        pendingSaveData.access,
      );

      if (result.success) {
        const tabId = pendingSaveData.tabId;
        markTabSaved(
          tabId,
          pendingSaveData.path,
          pendingSaveData.access,
          pendingSaveData.content,
          pendingSaveData.connectionId,
          pendingSaveData.databaseId,
          pendingSaveData.databaseName,
        );

        await addToConsoleTree(workspaceId, pendingSaveData.path, tabId);

        showSnackbar(`Console saved at '${pendingSaveData.path}.js'`);

        trackEvent("console_saved", {
          console_id: tabId,
          is_new: true,
          was_overwrite: true,
        });
      } else {
        showError(result.error || "Failed to save after overwrite");
      }
    } catch (error: any) {
      showError(error?.message || "Failed to overwrite");
    }

    setPendingSaveData(null);
    setConflictData(null);
    setIsSaving(false);
  };

  const handleSaveDialogConfirm = async (
    name: string,
    folderId: string | null,
    section: "my" | "workspace",
  ) => {
    if (!saveDialogTabId || !workspaceId) return;
    setSaveDialogOpen(false);

    // Build the path: if folderId is provided the API will handle folder association via the path or directly
    const savePath = name.endsWith(".js") ? name.slice(0, -3) : name;
    const targetId = saveDialogTargetId ?? saveDialogTabId;
    const mode = saveDialogMode;
    const access = sectionAccess(section);

    setIsSaving(true);
    try {
      // Source tab (for connection/chart/view-mode). Even in "save-as-copy",
      // the new record inherits these from the source tab.
      const sourceTab = useConsoleStore.getState().tabs[saveDialogTabId];
      const connectionId = sourceTab?.connectionId;
      const databaseId = sourceTab?.databaseId;
      const databaseName = sourceTab?.databaseName;
      const pending: PendingSave = {
        tabId: targetId,
        content: saveDialogContent,
        path: savePath,
        connectionId,
        databaseId,
        databaseName,
        access,
      };

      if (mode === "rename-move") {
        // PUT /consoles/:id — updates the existing console's path.
        const result = await saveConsole(
          workspaceId,
          targetId,
          saveDialogContent,
          savePath,
          connectionId,
          databaseName,
          databaseId,
          tabChartSpecs[saveDialogTabId] ?? undefined,
          tabViewModes[saveDialogTabId],
          undefined,
          access,
        );

        if (result.error === "conflict" && result.conflict) {
          showConflict(pending, result.conflict);
          return;
        }

        if (result.success) {
          markTabSaved(
            targetId,
            savePath,
            access,
            saveDialogContent,
            connectionId,
            databaseId,
            databaseName,
          );

          trackEvent("console_renamed", {
            console_id: targetId,
            new_path: savePath,
          });

          showSnackbar(`Renamed to '${savePath}.js'`);

          await refreshConsoleTree(workspaceId);
        } else {
          showError(JSON.stringify(result.error, null, 2));
        }

        return;
      }

      // Both "new" and "save-as-copy" use POST to create a new record.
      const { status, body: result } = await useConsoleStore
        .getState()
        .createConsoleRecord(workspaceId, {
          id: targetId,
          path: savePath,
          content: saveDialogContent,
          connectionId,
          databaseName,
          databaseId,
          folderId: folderId || undefined,
          access,
          isPrivate: section !== "workspace",
          chartSpec: tabChartSpecs[saveDialogTabId] ?? null,
          resultsViewMode: tabViewModes[saveDialogTabId],
          comment: "",
        });

      if (status === 409 && result.error === "conflict" && result.conflict) {
        showConflict(pending, result.conflict);
        return;
      }

      if (result.success) {
        if (mode === "save-as-copy") {
          // Do NOT mutate the source tab. Just refresh the tree so the copy
          // shows up. Optionally we could also open the new console as a tab,
          // but keep the UX conservative: user stays focused on their work.
          trackEvent("console_saved_as_copy", {
            source_console_id: saveDialogTabId,
            new_console_id: targetId,
          });
          showSnackbar(`Saved a copy as '${savePath}.js'`);
        } else {
          // "new" — first-time save of a draft; update the originating tab.
          markTabSaved(
            targetId,
            savePath,
            access,
            saveDialogContent,
            connectionId,
            databaseId,
            databaseName,
          );

          trackEvent("console_saved", {
            console_id: targetId,
            is_new: true,
          });

          showSnackbar(`Console saved as '${savePath}'`);
        }

        await refreshConsoleTree(workspaceId);
      } else {
        showError(JSON.stringify(result.error, null, 2));
      }
    } catch (e: any) {
      showError(JSON.stringify(e, null, 2));
    } finally {
      setIsSaving(false);
      resetSaveDialog();
    }
  };

  const handleSaveDialogClose = () => {
    setSaveDialogOpen(false);
    resetSaveDialog();
  };

  // "Save a Copy..." — POST a brand-new console record with a fresh id; the
  // currently open tab keeps pointing at the original file.
  const handleSaveAsCopy = useStableCallback(
    (tabId: string, contentToSave: string) => {
      if (!workspaceId) {
        showError("No workspace selected");
        return;
      }
      openSaveDialog("save-as-copy", tabId, generateObjectId(), contentToSave);
    },
  );

  // "Rename / Move..." — relocate the existing console (same id) to a new path.
  const handleRenameMove = useStableCallback(
    (tabId: string, contentToSave: string, currentPath?: string) => {
      if (!workspaceId) {
        showError("No workspace selected");
        return;
      }
      // Nothing to rename yet — fall back to first-time save flow.
      openSaveDialog(
        currentPath ? "rename-move" : "new",
        tabId,
        tabId,
        contentToSave,
      );
    },
  );

  const handleConflictSaveAsNew = () => {
    setConflictDialogOpen(false);
    setConflictData(null);

    if (pendingSaveData) {
      // Re-open the dialog to let the user pick a new name.
      openSaveDialog(
        "new",
        pendingSaveData.tabId,
        pendingSaveData.tabId,
        pendingSaveData.content,
      );
    }
    setPendingSaveData(null);
  };

  const handleConflictClose = () => {
    setConflictDialogOpen(false);
    setConflictData(null);
    setPendingSaveData(null);
  };

  // ── Concurrent-edit (version) conflict resolution ──────────────────

  const fastForwardDraftRevision = (
    tabId: string,
    conflict: ConsoleVersionConflict,
  ) => {
    if (typeof conflict.currentDraftRevision === "number") {
      useConsoleStore
        .getState()
        .updateDraftRevision(tabId, conflict.currentDraftRevision);
    }
  };

  const handleVersionConflictOverwrite = async () => {
    if (!pendingSaveData || !versionConflictData) return;
    const { tabId, content, path, comment } = pendingSaveData;
    // Fast-forward to the server's bases so the retried save passes BOTH
    // guards (unless someone saves yet again in the meantime).
    updateVersion(tabId, versionConflictData.currentVersion);
    fastForwardDraftRevision(tabId, versionConflictData);
    setVersionConflictData(null);
    const success = await executeConsoleSave(
      tabId,
      content,
      path,
      comment ?? "",
    );
    if (success) {
      setPendingSaveData(null);
    }
  };

  const handleVersionConflictLoadLatest = () => {
    if (!pendingSaveData || !versionConflictData) return;
    const { tabId } = pendingSaveData;
    const serverContent = versionConflictData.content;
    // Replace the editor buffer with the server copy (the previous local
    // content stays reachable via Monaco undo) and reset the baseline.
    getConsoleRef(tabId).current?.applyModification({
      action: "replace",
      content: serverContent,
    });
    updateContent(tabId, serverContent);
    updateVersion(tabId, versionConflictData.currentVersion);
    fastForwardDraftRevision(tabId, versionConflictData);
    const currentTab = useConsoleStore.getState().tabs[tabId];
    const newHash = computeConsoleStateHash(
      serverContent,
      currentTab?.connectionId,
      currentTab?.databaseId,
      currentTab?.databaseName,
    );
    updateSavedState(tabId, true, newHash);
    setVersionConflictData(null);
    setPendingSaveData(null);
  };

  const handleVersionConflictClose = () => {
    setVersionConflictData(null);
    setPendingSaveData(null);
  };

  return {
    isSaving,
    saveSuggestion,
    saveDialogOpen,
    saveDialogTabId,
    saveDialogMode,
    commentDialogOpen,
    conflictDialogOpen,
    conflictData,
    versionConflictData,
    pendingSaveContent: pendingSaveData?.content || "",
    handleConsoleSave,
    handleSaveAsCopy,
    handleRenameMove,
    handleCommentSaveConfirm,
    handleCommentSaveCancel,
    handleSaveDialogConfirm,
    handleSaveDialogClose,
    handleConflictOverwrite,
    handleConflictSaveAsNew,
    handleConflictClose,
    handleVersionConflictOverwrite,
    handleVersionConflictLoadLatest,
    handleVersionConflictClose,
  };
}
