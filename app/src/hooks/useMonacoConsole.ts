import { useRef, useCallback, useState, useEffect } from "react";
import { useConsoleStore } from "../store/consoleStore";

export interface ConsoleModification {
  action: "replace" | "insert" | "append" | "create" | "patch";
  content: string;
  position?: {
    line: number;
    column: number;
  };
  startLine?: number;
  endLine?: number;
}

// Extended ConsoleModification with fields for console creation/modification handlers
export type ConsoleModificationPayload = ConsoleModification & {
  consoleId?: string;
  title?: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  isDirty?: boolean;
};

interface UseMonacoConsoleOptions {
  consoleId: string;
  onContentChange?: (content: string) => void;
  onVersionChange?: (canUndo: boolean, canRedo: boolean) => void;
  workspaceId?: string;
  language?: string;
  title?: string;
}

export const useMonacoConsole = (options: UseMonacoConsoleOptions) => {
  const {
    consoleId,
    onContentChange,
    onVersionChange,
    workspaceId,
    language,
    title,
  } = options;
  const editorRef = useRef<any>(null);
  const isApplyingModificationRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Get version manager and comment generator from store
  const { getVersionManager, generateVersionComment } = useConsoleStore();

  // Get the version manager for this console
  const getVersionManagerForConsole = useCallback(() => {
    return getVersionManager(consoleId);
  }, [consoleId, getVersionManager]);

  // Update version control state
  const updateVersionState = useCallback(() => {
    const manager = getVersionManagerForConsole();
    if (!manager) return;

    const newCanUndo = manager.canUndo();
    const newCanRedo = manager.canRedo();

    setCanUndo(newCanUndo);
    setCanRedo(newCanRedo);

    if (onVersionChange) {
      onVersionChange(newCanUndo, newCanRedo);
    }
  }, [getVersionManagerForConsole, onVersionChange]);

  const requestVersionComment = useCallback(
    (
      versionId: string,
      previousContent: string,
      newContent: string,
      source: "user" | "ai",
      aiPrompt?: string,
    ) => {
      if (!workspaceId) return;
      if (previousContent === newContent) return;
      if (previousContent.trim() === newContent.trim()) return;

      generateVersionComment(workspaceId, consoleId, versionId, {
        previousContent,
        newContent,
        language: language || "sql",
        source,
        aiPrompt,
        title,
      });
    },
    [workspaceId, consoleId, language, title, generateVersionComment],
  );

  // Set the editor reference
  const setEditor = useCallback((editor: any) => {
    editorRef.current = editor;
  }, []);

  // Apply a console modification
  const applyModification = useCallback(
    (modification: ConsoleModification) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      const model = editor.getModel();
      if (!model) {
        return;
      }

      const versionManager = getVersionManagerForConsole();
      if (!versionManager) {
        return;
      }

      // Save current state before modification
      const currentContent = model.getValue();
      versionManager.saveVersion(
        currentContent,
        "user",
        "Before AI modification",
      );

      isApplyingModificationRef.current = true;

      try {
        switch (modification.action) {
          case "replace":
            model.setValue(modification.content);
            break;

          case "append": {
            const lineCount = model.getLineCount();
            const lastLineLength = model.getLineLength(lineCount);
            const position = new editor.monaco.Position(
              lineCount,
              lastLineLength + 1,
            );
            const range = new editor.monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            );

            editor.executeEdits("ai-modification", [
              {
                range: range,
                text:
                  (currentContent.endsWith("\n") ? "" : "\n") +
                  modification.content,
                forceMoveMarkers: true,
              },
            ]);
            break;
          }

          case "insert": {
            const position = modification.position
              ? new editor.monaco.Position(
                  modification.position.line,
                  modification.position.column,
                )
              : editor.getPosition() || new editor.monaco.Position(1, 1);

            const range = new editor.monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            );

            editor.executeEdits("ai-modification", [
              {
                range: range,
                text: modification.content,
                forceMoveMarkers: true,
              },
            ]);
            break;
          }

          case "patch": {
            // Patch replaces specific line range with new content
            if (!modification.startLine || !modification.endLine) {
              console.warn(
                "[useMonacoConsole] patch action requires startLine and endLine",
              );
              break;
            }

            const startLine = modification.startLine;
            const endLine = modification.endLine;

            // Clamp to valid line numbers
            const totalLines = model.getLineCount();
            const safeStartLine = Math.max(1, Math.min(startLine, totalLines));
            const safeEndLine = Math.max(
              safeStartLine,
              Math.min(endLine, totalLines),
            );

            // Get the length of the end line to create a proper range
            const endLineLength = model.getLineLength(safeEndLine);

            // Create range from start of startLine to end of endLine
            const range = new editor.monaco.Range(
              safeStartLine,
              1,
              safeEndLine,
              endLineLength + 1,
            );

            editor.executeEdits("ai-patch", [
              {
                range: range,
                text: modification.content,
                forceMoveMarkers: true,
              },
            ]);
            break;
          }
        }

        // Save the new state after modification
        const newContent = model.getValue();
        const aiVersionId = versionManager.saveVersion(
          newContent,
          "ai",
          `AI ${modification.action}`,
        );

        requestVersionComment(aiVersionId, currentContent, newContent, "ai");

        // Flash the editor to indicate change
        flashEditor(editor);

        // Update version state
        updateVersionState();

        // Notify content change
        if (onContentChange) {
          onContentChange(newContent);
        }
      } finally {
        isApplyingModificationRef.current = false;
      }

      // Focus the editor
      editor.focus();
    },
    [
      getVersionManagerForConsole,
      onContentChange,
      updateVersionState,
      requestVersionComment,
    ],
  );

  // Undo functionality
  const undo = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const versionManager = getVersionManagerForConsole();
    if (!versionManager) return;

    const content = versionManager.undo();
    if (content !== null) {
      const model = editor.getModel();
      if (model) {
        isApplyingModificationRef.current = true;
        model.setValue(content);
        isApplyingModificationRef.current = false;

        updateVersionState();

        if (onContentChange) {
          onContentChange(content);
        }
      }
    }
  }, [getVersionManagerForConsole, onContentChange, updateVersionState]);

  // Redo functionality
  const redo = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const versionManager = getVersionManagerForConsole();
    if (!versionManager) return;

    const content = versionManager.redo();
    if (content !== null) {
      const model = editor.getModel();
      if (model) {
        isApplyingModificationRef.current = true;
        model.setValue(content);
        isApplyingModificationRef.current = false;

        updateVersionState();

        if (onContentChange) {
          onContentChange(content);
        }
      }
    }
  }, [getVersionManagerForConsole, onContentChange, updateVersionState]);

  // Get version history
  const getHistory = useCallback(() => {
    const versionManager = getVersionManagerForConsole();
    if (!versionManager) return [];
    return versionManager.getHistory();
  }, [getVersionManagerForConsole]);

  // Restore a specific version
  const restoreVersion = useCallback(
    (versionId: string) => {
      const editor = editorRef.current;
      if (!editor) return;

      const versionManager = getVersionManagerForConsole();
      if (!versionManager) return;

      const content = versionManager.restoreVersion(versionId);
      if (content !== null) {
        const model = editor.getModel();
        if (model) {
          isApplyingModificationRef.current = true;
          model.setValue(content);
          isApplyingModificationRef.current = false;

          updateVersionState();

          if (onContentChange) {
            onContentChange(content);
          }
        }
      }
    },
    [getVersionManagerForConsole, onContentChange, updateVersionState],
  );

  // Save user edit as a version
  const saveUserEdit = useCallback(
    (content: string, description?: string) => {
      if (!isApplyingModificationRef.current) {
        const versionManager = getVersionManagerForConsole();
        if (!versionManager) return;

        const versionId = versionManager.saveVersion(
          content,
          "user",
          description,
        );
        updateVersionState();

        if (
          description !== "Initial content" &&
          description !== "Before AI modification"
        ) {
          const previousContent = versionManager.getPreviousContent(versionId);
          if (previousContent !== null) {
            requestVersionComment(versionId, previousContent, content, "user");
          }
        }
      }
    },
    [getVersionManagerForConsole, updateVersionState, requestVersionComment],
  );

  // Clear version history
  const clearHistory = useCallback(() => {
    const versionManager = getVersionManagerForConsole();
    if (!versionManager) return;

    versionManager.clear();
    updateVersionState();
  }, [getVersionManagerForConsole, updateVersionState]);

  // Initialize version state on mount
  useEffect(() => {
    updateVersionState();
  }, [updateVersionState]);

  return {
    setEditor,
    applyModification,
    undo,
    redo,
    canUndo,
    canRedo,
    getHistory,
    restoreVersion,
    saveUserEdit,
    clearHistory,
    isApplyingModification: isApplyingModificationRef,
  };
};

// Helper function to flash the editor for visual feedback
function flashEditor(editor: any) {
  const originalBackground = editor.getDomNode()?.style.backgroundColor || "";
  const flashColor = "rgba(59, 130, 246, 0.1)"; // Blue flash

  const domNode = editor.getDomNode();
  if (domNode) {
    domNode.style.transition = "background-color 200ms ease-in-out";
    domNode.style.backgroundColor = flashColor;

    setTimeout(() => {
      if (domNode) {
        domNode.style.backgroundColor = originalBackground;

        setTimeout(() => {
          if (domNode) {
            domNode.style.transition = "";
          }
        }, 200);
      }
    }, 200);
  }
}
