import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleModification } from "../../../hooks/useMonacoConsole";
import {
  getPendingAgentReview,
  useConsoleStore,
} from "../../../store/consoleStore";
import { applyModification as applyConsoleModification } from "../../../utils/consoleModification";

interface UseConsoleDiffArgs {
  consoleId: string;
  workspaceId: string | undefined;
  editorRef: React.RefObject<any>;
  /** Set while the editor content is replaced programmatically. */
  isProgrammaticUpdateRef: React.MutableRefObject<boolean>;
  /** Last content recorded as the editor's baseline for version history. */
  lastInitialContentRef: React.MutableRefObject<string>;
  /** Remount the plain editor (after leaving diff mode). */
  remountEditor: () => void;
  editorMounted: boolean;
  enableVersionControl: boolean;
  saveUserEdit: (content: string, description: string) => void;
  onContentChange?: (content: string) => void;
  /** Draft autosave for unsaved consoles (no-op once explicitly saved). */
  autoSaveContent: (content: string) => void;
}

/**
 * The review diff for AI edits: a local modification (showDiff) or an agent
 * (modify_console) edit already on the server draft (showRemoteDiff). The
 * baseline (`originalContent`) is kept across cumulative edits until the user
 * accepts or rejects.
 */
export function useConsoleDiff({
  consoleId,
  workspaceId,
  editorRef,
  isProgrammaticUpdateRef,
  lastInitialContentRef,
  remountEditor,
  editorMounted,
  enableVersionControl,
  saveUserEdit,
  onContentChange,
  autoSaveContent,
}: UseConsoleDiffArgs) {
  const resolveAgentReview = useConsoleStore(state => state.resolveAgentReview);

  const [isDiffMode, setIsDiffMode] = useState(false);
  const [originalContent, setOriginalContent] = useState("");
  const [modifiedContent, setModifiedContent] = useState("");
  const [pendingModification, setPendingModification] =
    useState<ConsoleModification | null>(null);
  // True while the active diff is an agent (modify_console) edit awaiting
  // review — resolved against the server draft via the console store rather
  // than the legacy local-modification path.
  const isRemoteDiffRef = useRef(false);

  // Full editor content (ignores selection); the modified side in diff mode.
  const getFullEditorContent = useCallback(() => {
    if (isDiffMode) {
      return modifiedContent || "";
    }
    return editorRef.current?.getValue() || "";
  }, [isDiffMode, modifiedContent, editorRef]);

  const clearDiff = () => {
    setPendingModification(null);
    setOriginalContent("");
    setModifiedContent("");
  };

  /** Leave diff mode into a fresh editor that will show `content`. */
  const exitDiffInto = (content: string) => {
    setIsDiffMode(false);
    remountEditor();
    isProgrammaticUpdateRef.current = true;
    lastInitialContentRef.current = content;
    clearDiff();
  };

  // Show diff instead of applying modification immediately
  // When already in diff mode (follow-up request), preserve the original baseline
  // and apply the new modification to the current modified content
  const showDiff = useCallback(
    (modification: ConsoleModification) => {
      const currentContent = getFullEditorContent();
      const newContent = applyConsoleModification(currentContent, modification);

      // Only set originalContent if NOT already in diff mode
      // This preserves the true baseline for cumulative agent changes
      if (!isDiffMode) {
        setOriginalContent(currentContent);
      }

      isRemoteDiffRef.current = false;
      setModifiedContent(newContent);
      setPendingModification(modification);
      setIsDiffMode(true);
    },
    [getFullEditorContent, isDiffMode],
  );

  // Surface an agent (modify_console) edit as a reviewable diff. The change is
  // already persisted to the server draft; the editor keeps the pre-agent
  // baseline (originalContent) until the user accepts/rejects. Cumulative
  // agent edits preserve the baseline and just refresh the modified side.
  const showRemoteDiff = useCallback(
    (proposedContent: string) => {
      if (!isDiffMode) {
        setOriginalContent(getFullEditorContent());
      }
      isRemoteDiffRef.current = true;
      setPendingModification(null);
      setModifiedContent(proposedContent);
      setIsDiffMode(true);
    },
    [getFullEditorContent, isDiffMode],
  );

  /** After the remount, make sure the new model holds `content`. */
  const settleEditorTo = (content: string) => {
    setTimeout(() => {
      const model = editorRef.current?.getModel();
      if (model && model.getValue() !== content) {
        model.setValue(content);
      }
      isProgrammaticUpdateRef.current = false;
    }, 100);
  };

  // Accept the changes
  const acceptChanges = () => {
    // Agent diff: the server already holds the proposed content — adopt it in
    // the editor and let the store reconcile revision/baseline.
    if (isRemoteDiffRef.current) {
      const proposed = modifiedContent;
      const base = originalContent;
      isRemoteDiffRef.current = false;
      exitDiffInto(proposed);

      if (enableVersionControl) {
        saveUserEdit(base, "Before AI modification");
        saveUserEdit(proposed, "AI modification");
      }

      settleEditorTo(proposed);

      if (workspaceId) {
        void resolveAgentReview(workspaceId, consoleId, "accept");
      }
      return;
    }

    if (pendingModification && modifiedContent) {
      const savedModifiedContent = modifiedContent;
      const savedOriginalContent = originalContent;
      const savedModification = pendingModification;
      exitDiffInto(savedModifiedContent);

      setTimeout(() => {
        const model = editorRef.current?.getModel();
        if (model) {
          model.setValue(savedModifiedContent);

          if (enableVersionControl) {
            saveUserEdit(savedOriginalContent, "Before AI modification");
            saveUserEdit(
              savedModifiedContent,
              `AI ${savedModification.action}`,
            );
          }

          onContentChange?.(savedModifiedContent);

          // Auto-save agent modifications (debounced internally)
          autoSaveContent(savedModifiedContent);
        }
        isProgrammaticUpdateRef.current = false;
      }, 100);
    }
  };

  // Reject the changes and restore the original baseline
  const rejectChanges = () => {
    // Agent diff: the server holds the agent's content — restore the editor to
    // the pre-agent baseline and let the store revert the server draft.
    if (isRemoteDiffRef.current) {
      const base = originalContent;
      isRemoteDiffRef.current = false;
      exitDiffInto(base);
      settleEditorTo(base);

      if (workspaceId) {
        void resolveAgentReview(workspaceId, consoleId, "reject");
      }
      return;
    }

    // Restore editor content to original baseline and sync store
    if (originalContent && onContentChange) {
      onContentChange(originalContent);
    }

    setIsDiffMode(false);
    clearDiff();
  };

  // Surface a pending agent diff when this tab mounts/activates after the edit
  // landed while it was in the background (the dispatch from beginAgentReview
  // is idempotent and won't re-fire once a review is recorded, so a freshly
  // mounted editor pulls the proposal from the store itself).
  useEffect(() => {
    if (!editorMounted || isDiffMode) return;
    const review = getPendingAgentReview(consoleId);
    if (review) {
      showRemoteDiff(review.proposedContent);
    }
  }, [editorMounted, isDiffMode, consoleId, showRemoteDiff]);

  return {
    isDiffMode,
    originalContent,
    modifiedContent,
    getFullEditorContent,
    showDiff,
    showRemoteDiff,
    acceptChanges,
    rejectChanges,
  };
}
