import React, {
  useRef,
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
} from "react";
import { Box } from "@mui/material";
import Editor, { DiffEditor } from "../lib/monaco/MonacoEditor";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { useTheme } from "../contexts/ThemeContext";
import { useWorkspace } from "../contexts/workspace-context";
import { useSchemaStore, TreeNode } from "../store/schemaStore";
import { useMonacoConsole } from "../hooks/useMonacoConsole";
import ConsoleInfoModal from "./ConsoleInfoModal";
import { useConsoleStore, markUserEditActivity } from "../store/consoleStore";
import { computeConsoleStateHash } from "../utils/stateHash";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  onRenderDebug,
  useRenderCount,
  useWhyChanged,
} from "../utils/renderDebug";
import { consoleEditorLanguage } from "./console/console-utils";
import { useSqlTableValidation } from "./console/hooks/useSqlTableValidation";
import { useConsoleDiff } from "./console/hooks/useConsoleDiff";
import { MobileConsoleToolbar } from "./console/MobileConsoleToolbar";
import { DesktopConsoleToolbar } from "./console/DesktopConsoleToolbar";
import { ConsoleDiffBar, ConsoleRunFab } from "./console/ConsoleDiffBar";
import type { ConsoleToolbarProps } from "./console/toolbar-props";
import type { ConsoleProps, ConsoleRef } from "./console/types";

export type { ConsoleRef };

/** Keep a ref pointing at the latest value (for Monaco command closures). */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/** Move the cursor to the end of the editor's content. */
function moveCursorToEnd(editor: any, model: any) {
  const lineCount = model.getLineCount();
  const lastLineLength = model.getLineLength(lineCount);
  editor.setPosition({
    lineNumber: lineCount,
    column: lastLineLength + 1,
  });
}

const Console = forwardRef<ConsoleRef, ConsoleProps>((props, ref) => {
  const {
    consoleId,
    initialContent,
    title,
    onExecute,
    onCancel,
    onSave,
    onSaveAsCopy,
    onRenameMove,
    isExecuting,
    isCancelling,
    isSaving,
    onContentChange,
    databases = [],
    // Current database selection (single source of truth from store)
    connectionId,
    databaseId,
    databaseName,
    onDatabaseChange,
    onDatabaseNameChange,
    filePath,
    onHistoryClick,
    historyAvailable = true,
    onShareClick,
    shareAvailable = true,
    enableVersionControl = false,
    schedule,
    onCreateSchedule,
    onUpdateSchedule,
    variant = "console",
    headerExtras,
  } = props;
  void variant;

  const editorRef = useRef<any>(null);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { effectiveMode } = useTheme();
  const monacoTheme = useMonacoTheme();
  const { currentWorkspace } = useWorkspace();
  const autoSaveConsole = useConsoleStore(state => state.autoSaveConsole);
  const tabs = useConsoleStore(state => state.tabs);

  // Get tab state for savedStateHash (used for dirty tracking)
  const tab = tabs[consoleId];
  const savedStateHash = tab?.savedStateHash;
  const isSaved = tab?.isSaved ?? false;
  const isReadOnly = tab?.readOnly ?? false;
  const hasSchedule = Boolean(
    schedule?.cron?.trim() && schedule?.timezone?.trim(),
  );

  // State for info modal
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [monacoInstance, setMonacoInstance] = useState<any>(null);

  // Compute dirty state by comparing current state hash vs saved state hash
  const hasUnsavedChanges = useMemo(() => {
    if (!savedStateHash) return true; // Never saved
    const currentContent = tab?.content || "";
    const currentHash = computeConsoleStateHash(
      currentContent,
      connectionId,
      databaseId,
      databaseName,
    );
    return currentHash !== savedStateHash;
  }, [savedStateHash, tab?.content, connectionId, databaseId, databaseName]);

  // State to track Monaco's undo/redo availability
  const [monacoCanUndo, setMonacoCanUndo] = useState(false);
  const [monacoCanRedo, setMonacoCanRedo] = useState(false);
  const syncUndoRedo = useCallback((model: any) => {
    setMonacoCanUndo(model.canUndo());
    setMonacoCanRedo(model.canRedo());
  }, []);

  // Flips true once Monaco has mounted; used to surface a pending agent diff
  // when this tab becomes active after the edit landed in the background.
  const [editorMounted, setEditorMounted] = useState(false);
  // Editor key to force remount when needed
  const [editorKey, setEditorKey] = useState(0);
  const remountEditor = useCallback(() => setEditorKey(prev => prev + 1), []);

  // Refs for tracking state without triggering re-renders
  const isProgrammaticUpdateRef = useRef(false);
  const lastInitialContentRef = useRef(initialContent);
  // Two independent debouncers: sharing one timer ref let the content flush
  // cancel the trailing version-history save on every keystroke.
  const versionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const contentFlushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const filePathRef = useLatestRef(filePath);
  const monacoRef = useRef<any>(null);

  // Use unified schema store
  const ensureTreeRoot = useSchemaStore(s => s.ensureTreeRoot);
  const treeNodes = useSchemaStore(s => s.treeNodes);
  const schemaLoading = useSchemaStore(s => s.loading);
  const ensureAutocompleteSchema = useSchemaStore(
    s => s.ensureAutocompleteSchema,
  );
  const autocompleteSchemas = useSchemaStore(s => s.autocompleteSchemas);

  // Use the Monaco console hook for version management
  const {
    setEditor,
    applyModification,
    undo,
    redo,
    canUndo,
    canRedo,
    saveUserEdit,
    isApplyingModification,
  } = useMonacoConsole({
    consoleId,
    onContentChange: enableVersionControl ? onContentChange : undefined,
    workspaceId: currentWorkspace?.id,
    title,
  });

  // Track if we've saved the initial version
  const hasInitialVersionRef = useRef(false);

  // Reset initial version flag when console changes
  useEffect(() => {
    hasInitialVersionRef.current = false;
  }, [consoleId]);

  // Keep refs of the latest callbacks and props to avoid stale closures in Monaco commands
  const onExecuteRef = useLatestRef(onExecute);
  const onSaveRef = useLatestRef(onSave);
  const onSaveAsCopyRef = useLatestRef(onSaveAsCopy);
  const onRenameMoveRef = useLatestRef(onRenameMove);
  const connectionIdRef = useLatestRef(connectionId);
  const databaseIdRef = useLatestRef(databaseId);

  /**
   * Draft autosave (debounced internally by autoSaveConsole). Skipped once
   * the console is explicitly saved (isSaved=true).
   */
  const autoSaveContent = useCallback(
    (content: string) => {
      if (!isSaved && currentWorkspace?.id && consoleId && content.trim()) {
        autoSaveConsole(
          currentWorkspace.id,
          consoleId,
          content,
          title,
          connectionIdRef.current,
          databaseIdRef.current,
          databaseName,
        );
      }
    },
    [
      isSaved,
      currentWorkspace?.id,
      consoleId,
      title,
      databaseName,
      autoSaveConsole,
      connectionIdRef,
      databaseIdRef,
    ],
  );

  const {
    isDiffMode,
    originalContent,
    modifiedContent,
    getFullEditorContent,
    showDiff,
    showRemoteDiff,
    acceptChanges,
    rejectChanges,
  } = useConsoleDiff({
    consoleId,
    workspaceId: currentWorkspace?.id,
    editorRef,
    isProgrammaticUpdateRef,
    lastInitialContentRef,
    remountEditor,
    editorMounted,
    enableVersionControl,
    saveUserEdit,
    onContentChange,
    autoSaveContent,
  });

  useRenderCount("Console", {
    consoleId,
    title,
    isDiffMode,
    editorKey,
  });
  useWhyChanged("Console", {
    consoleId,
    initialContentRef: initialContent,
    title,
    tabRef: tab,
    tabContentRef: tab?.content,
    savedStateHash,
    isSaved,
    isReadOnly,
    hasUnsavedChanges,
    isExecuting,
    isCancelling,
    isSaving,
    isDiffMode,
    editorKey,
    connectionId,
    databaseId,
    databaseName,
    databasesRef: databases,
    onExecute,
    onCancel,
    onSave,
    onContentChange,
    effectiveMode,
  });

  // Derived state for databases
  const selectedConnection = useMemo(
    () => databases.find(db => db.id === connectionId),
    [databases, connectionId],
  );

  // Get available databases (sub-databases for cluster mode) from tree nodes
  const availableDatabases: TreeNode[] = useMemo(() => {
    if (!connectionId) return [];
    // For cluster mode, root nodes are databases
    return treeNodes[connectionId]?.["root"] || [];
  }, [treeNodes, connectionId]);

  const isLoadingDatabases =
    schemaLoading[`tree:${connectionId}:root`] || false;

  // Fetch sub-databases if needed (for cluster mode)
  useEffect(() => {
    if (
      selectedConnection?.isClusterMode &&
      connectionId &&
      currentWorkspace?.id
    ) {
      ensureTreeRoot(currentWorkspace.id, connectionId);
    }
  }, [selectedConnection, connectionId, ensureTreeRoot, currentWorkspace?.id]);

  // Fetch autocomplete data when connection changes
  useEffect(() => {
    // Lazy autocomplete connections use schemaStore (ensureTreeChildren, ensureColumns).
    if (selectedConnection?.type === "bigquery") return;

    if (connectionId && currentWorkspace?.id) {
      ensureAutocompleteSchema(currentWorkspace.id, connectionId);
    }
  }, [
    connectionId,
    currentWorkspace?.id,
    ensureAutocompleteSchema,
    selectedConnection?.type,
  ]);

  // SQL autocomplete is handled at the Editor level (single global provider);
  // this only adds the debounced unknown-table warnings.
  useSqlTableValidation(
    monacoInstance,
    editorRef,
    connectionId,
    autocompleteSchemas,
  );

  // Helper function to get content for execution (selected text if there's a selection, otherwise full content)
  const getExecutionContent = useCallback(() => {
    const editor = isDiffMode
      ? diffEditorRef.current?.getModifiedEditor()
      : editorRef.current;
    if (editor) {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (selection && !selection.isEmpty() && model) {
        return model.getValueInRange(selection);
      }
    }
    if (isDiffMode) return modifiedContent || "";
    return editorRef.current?.getValue() || "";
  }, [isDiffMode, modifiedContent]);

  // Execute handler
  const handleExecute = useCallback(() => {
    const content = getExecutionContent();
    if (onExecuteRef.current) {
      onExecuteRef.current(
        content,
        connectionIdRef.current || undefined,
        databaseIdRef.current,
      );
    }
  }, [getExecutionContent, onExecuteRef, connectionIdRef, databaseIdRef]);

  // Save handler - always saves full content regardless of selection
  const handleSave = useCallback(async () => {
    if (onSaveRef.current) {
      const content = getFullEditorContent();
      await onSaveRef.current(content, filePathRef.current);
      // Editor.tsx handles updating savedStateHash on success
    }
  }, [getFullEditorContent, onSaveRef, filePathRef]);

  const handleSaveAsCopy = useCallback(() => {
    if (onSaveAsCopyRef.current) {
      const content = getFullEditorContent();
      onSaveAsCopyRef.current(content);
    }
  }, [getFullEditorContent, onSaveAsCopyRef]);

  const handleRenameMove = useCallback(() => {
    if (onRenameMoveRef.current) {
      const content = getFullEditorContent();
      onRenameMoveRef.current(content, filePathRef.current);
    }
  }, [getFullEditorContent, onRenameMoveRef, filePathRef]);

  // Calculate editor language
  const editorLanguage = useMemo(
    () =>
      consoleEditorLanguage(
        filePath,
        databases.find(db => db.id === connectionId)?.type,
      ),
    [filePath, databases, connectionId],
  );

  // Track the console ID to detect when we switch to a different console
  const lastConsoleIdRef = useRef(consoleId);

  useEffect(() => {
    if (consoleId !== lastConsoleIdRef.current) {
      lastConsoleIdRef.current = consoleId;

      if (!editorRef.current) {
        remountEditor();
        return;
      }

      const model = editorRef.current.getModel();
      if (model) {
        isProgrammaticUpdateRef.current = true;
        model.setValue(initialContent);
        isProgrammaticUpdateRef.current = false;

        moveCursorToEnd(editorRef.current, model);

        setMonacoCanUndo(false);
        setMonacoCanRedo(false);
      }
    }
  }, [consoleId, initialContent, remountEditor]);

  // Apply new initialContent from props when background fetch finishes
  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;
    const current = model.getValue();
    const isPlaceholder = current === "loading..." || current.trim() === "";

    if (isPlaceholder && initialContent && current !== initialContent) {
      isProgrammaticUpdateRef.current = true;
      model.setValue(initialContent);
      syncUndoRedo(model);
      isProgrammaticUpdateRef.current = false;
    }
  }, [initialContent, syncUndoRedo]);

  // On unmount, FLUSH a pending content change instead of dropping it: the
  // debounce is 500ms, and a tab switch inside that window used to lose the
  // last keystrokes from the persisted tab state.
  const pendingContentRef = useRef<string | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  useEffect(() => {
    return () => {
      if (versionSaveTimeoutRef.current) {
        clearTimeout(versionSaveTimeoutRef.current);
        versionSaveTimeoutRef.current = null;
      }
      if (contentFlushTimeoutRef.current) {
        clearTimeout(contentFlushTimeoutRef.current);
        contentFlushTimeoutRef.current = null;
      }
      const pending = pendingContentRef.current;
      pendingContentRef.current = null;
      if (pending !== null) onContentChangeRef.current?.(pending);
    };
  }, []);

  const handleEditorDidMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      setMonacoInstance(monaco);
      setEditorMounted(true);

      // Always connect editor to the hook (needed for AI modifications)
      setEditor(editor);

      // CMD/CTRL + Enter execution support
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const activeId = useConsoleStore.getState().activeTabId;
        if (activeId !== consoleId) {
          return;
        }
        handleExecute();
      });

      // CMD/CTRL + S save support (if onSave is provided)
      if (onSave) {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          handleSave();
        });
      }

      // CMD/CTRL + Shift + S → Save as Copy (fallback to first-time save when
      // onSaveAsCopy isn't available).
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
        () => {
          if (onSaveAsCopyRef.current) {
            handleSaveAsCopy();
          } else if (onSaveRef.current) {
            handleSave();
          }
        },
      );

      // Auto-focus the editor when it mounts
      editor.focus();

      // Position cursor at the end of the content
      const model = editor.getModel();
      if (model) {
        moveCursorToEnd(editor, model);

        const currentContent = model.getValue();

        // Mount-autosave is ONLY for drafts that have never synced with the
        // server (no draftRevision — e.g. legacy localStorage-restored tabs
        // whose server doc may not exist). Re-saving an already-synced draft
        // on every mount used to bump draftRevision with identical content,
        // which made every OTHER window's revision base stale and dead-ended
        // their autosaves in 409s. Agent-created consoles arrive with a
        // server revision, so they never take this path either.
        const mountTab = useConsoleStore.getState().tabs[consoleId];
        if (
          !isSaved &&
          mountTab?.draftRevision === undefined &&
          currentWorkspace?.id &&
          consoleId &&
          currentContent.trim()
        ) {
          autoSaveConsole(
            currentWorkspace.id,
            consoleId,
            currentContent,
            title,
            connectionId,
            databaseId,
            databaseName,
          );
        }

        // Save initial version for undo history
        if (enableVersionControl && !hasInitialVersionRef.current) {
          saveUserEdit(currentContent, "Initial content");
          hasInitialVersionRef.current = true;
        }

        syncUndoRedo(model);
      }
    },
    [
      enableVersionControl,
      setEditor,
      handleExecute,
      handleSave,
      handleSaveAsCopy,
      onSave,
      saveUserEdit,
      consoleId,
      isSaved,
      currentWorkspace,
      title,
      connectionId,
      databaseId,
      databaseName,
      autoSaveConsole,
      onSaveAsCopyRef,
      onSaveRef,
      syncUndoRedo,
    ],
  );

  // Debounced content change notification for persistence (zustand + localStorage)
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const content = value || "";

      // Update Monaco undo/redo state
      const model = editorRef.current?.getModel();
      if (model) syncUndoRedo(model);

      // Skip the rest if this is a programmatic update (to prevent feedback loops)
      if (isProgrammaticUpdateRef.current) {
        return;
      }

      // Realtime sync: record raw keystroke activity immediately. The store
      // dirty flag below is debounced, so remote updates consult this to
      // avoid replacing content typed within the last few seconds.
      markUserEditActivity(consoleId);

      // Save user edit to version history if version control is enabled
      if (
        enableVersionControl &&
        content !== lastInitialContentRef.current &&
        !isApplyingModification.current
      ) {
        const shouldSaveImmediately = !versionSaveTimeoutRef.current;

        if (versionSaveTimeoutRef.current) {
          clearTimeout(versionSaveTimeoutRef.current);
        }

        if (shouldSaveImmediately) {
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
        }

        versionSaveTimeoutRef.current = setTimeout(() => {
          versionSaveTimeoutRef.current = null;
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
        }, 500);
      }

      // Normal content change callback
      if (onContentChange) {
        if (contentFlushTimeoutRef.current) {
          clearTimeout(contentFlushTimeoutRef.current);
        }

        pendingContentRef.current = content;
        contentFlushTimeoutRef.current = setTimeout(() => {
          contentFlushTimeoutRef.current = null;
          pendingContentRef.current = null;
          onContentChange(content);
        }, 500);
      }

      // Auto-save console when content changes (debounced internally by autoSaveConsole)
      autoSaveContent(content);
    },
    [
      onContentChange,
      enableVersionControl,
      saveUserEdit,
      isApplyingModification,
      consoleId,
      autoSaveContent,
      syncUndoRedo,
    ],
  );

  // DiffEditor mount handler - set up CMD+Enter and store ref
  const handleDiffEditorDidMount = useCallback(
    (diffEditor: any, monaco: any) => {
      diffEditorRef.current = diffEditor;

      const modifiedEditor = diffEditor.getModifiedEditor();
      if (modifiedEditor) {
        modifiedEditor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
          () => {
            const content = getExecutionContent();
            if (onExecuteRef.current) {
              onExecuteRef.current(
                content,
                connectionIdRef.current || undefined,
                databaseIdRef.current,
              );
            }
          },
        );
      }
    },
    [getExecutionContent, onExecuteRef, connectionIdRef, databaseIdRef],
  );

  // Realtime sync: replace content as a single ranged edit (keeps the undo
  // stack usable) behind the programmatic-update guard so handleEditorChange
  // skips dirty-marking and autosave — otherwise two live tabs would
  // ping-pong saves at each other forever.
  const setRemoteContent = useCallback((content: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getValue() === content) return;

    isProgrammaticUpdateRef.current = true;
    try {
      editor.executeEdits("remote-sync", [
        {
          range: model.getFullModelRange(),
          text: content,
          forceMoveMarkers: true,
        },
      ]);
    } finally {
      isProgrammaticUpdateRef.current = false;
    }
    lastInitialContentRef.current = content;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getCurrentContent: () => {
        const content = getFullEditorContent();
        return {
          content,
          fileName: title ? `${title}.js` : "console.js",
          language: "javascript",
        };
      },
      applyModification,
      setRemoteContent,
      undo,
      redo,
      canUndo,
      canRedo,
      showDiff,
      showRemoteDiff,
      focus: () => {
        if (isDiffMode && diffEditorRef.current) {
          diffEditorRef.current.getModifiedEditor()?.focus();
        } else if (editorRef.current) {
          editorRef.current.focus();
        }
      },
    }),
    [
      getFullEditorContent,
      title,
      applyModification,
      setRemoteContent,
      undo,
      redo,
      canUndo,
      canRedo,
      showDiff,
      showRemoteDiff,
      isDiffMode,
    ],
  );

  // Undo/redo go through Monaco's own stack so the toolbar (desktop) and the
  // overflow menu (mobile) behave identically to the keyboard shortcuts.
  const runEditorCommand = useCallback(
    (command: "undo" | "redo") => {
      if (!editorRef.current) return;
      editorRef.current.trigger("keyboard", command, null);
      setTimeout(() => {
        const model = editorRef.current?.getModel();
        if (model) syncUndoRedo(model);
      }, 0);
    },
    [syncUndoRedo],
  );
  const runUndo = useCallback(
    () => runEditorCommand("undo"),
    [runEditorCommand],
  );
  const runRedo = useCallback(
    () => runEditorCommand("redo"),
    [runEditorCommand],
  );

  const handleConnectionChange = useCallback(
    (newConnectionId: string) => {
      const newConnection = databases.find(db => db.id === newConnectionId);
      if (onDatabaseChange) {
        onDatabaseChange(newConnectionId);
      }
      // For non-cluster mode: set databaseName from the connection's database
      // For cluster mode: clear and let user select from dropdown
      if (onDatabaseNameChange) {
        if (
          newConnection &&
          !newConnection.isClusterMode &&
          newConnection.databaseName
        ) {
          onDatabaseNameChange(undefined, newConnection.databaseName);
        } else {
          onDatabaseNameChange(undefined, undefined);
        }
      }
    },
    [databases, onDatabaseChange, onDatabaseNameChange],
  );

  const handleDatabaseSelect = (dbId: string | undefined) => {
    const db = availableDatabases.find(d => d.id === dbId);
    if (onDatabaseNameChange) {
      onDatabaseNameChange(dbId, db?.label);
    }
  };

  const toolbarProps: ConsoleToolbarProps = {
    connectionId,
    databaseId,
    isClusterMode: Boolean(selectedConnection?.isClusterMode),
    clusterDatabases: availableDatabases,
    isLoadingDatabases,
    onConnectionChange: handleConnectionChange,
    onDatabaseSelect: handleDatabaseSelect,
    isReadOnly,
    isSaved,
    hasSchedule,
    hasUnsavedChanges,
    hasFilePath: Boolean(filePathRef.current),
    isSaving,
    isExecuting,
    isCancelling,
    isDiffMode,
    canUndo: monacoCanUndo,
    canRedo: monacoCanRedo,
    enableVersionControl,
    historyAvailable,
    shareAvailable,
    onExecute: handleExecute,
    onCancel,
    onSave: onSave ? handleSave : undefined,
    canSaveAsCopy: Boolean(onSaveAsCopy),
    onSaveAsCopy: handleSaveAsCopy,
    canRenameMove: Boolean(onRenameMove),
    onRenameMove: handleRenameMove,
    onUndo: runUndo,
    onRedo: runRedo,
    onHistoryClick,
    onShareClick,
    onSchedule:
      onCreateSchedule || onUpdateSchedule
        ? () => (hasSchedule ? onUpdateSchedule?.() : onCreateSchedule?.())
        : undefined,
    onInfo: () => setInfoModalOpen(true),
    headerExtras,
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {isMobile && <MobileConsoleToolbar {...toolbarProps} />}
      <DesktopConsoleToolbar {...toolbarProps} isMobile={isMobile} />

      {/* Diff mode action bar - shown below the main toolbar */}
      {isDiffMode && (
        <ConsoleDiffBar onAccept={acceptChanges} onReject={rejectChanges} />
      )}

      <Box ref={containerRef} sx={{ flexGrow: 1, height: 0 }}>
        <React.Profiler
          id={`Console.monaco.${consoleId}`}
          onRender={onRenderDebug}
        >
          {!isDiffMode ? (
            <Editor
              key={editorKey}
              language={editorLanguage || "javascript"}
              defaultValue={lastInitialContentRef.current || initialContent}
              height="100%"
              theme={monacoTheme}
              onMount={handleEditorDidMount}
              onChange={handleEditorChange}
              options={{
                ...EDITOR_OPTIONS.code,
                readOnly: isReadOnly,
                fontSize: 12,
                wordWrap: "on",
              }}
            />
          ) : (
            <DiffEditor
              height="100%"
              theme={monacoTheme}
              language={editorLanguage || "javascript"}
              original={originalContent}
              modified={modifiedContent}
              onMount={handleDiffEditorDidMount}
              options={{
                ...EDITOR_OPTIONS.diff,
                fontSize: 12,
                wordWrap: "on",
                diffWordWrap: "on",
                renderSideBySide: false,
                enableSplitViewResizing: false,
              }}
            />
          )}
        </React.Profiler>
      </Box>

      {/* Info Modal */}
      <ConsoleInfoModal
        open={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        consoleId={consoleId}
        workspaceId={currentWorkspace?.id}
      />

      {isMobile && !isDiffMode && (
        <ConsoleRunFab
          isExecuting={isExecuting}
          isCancelling={isCancelling}
          canRun={Boolean(connectionId)}
          onExecute={handleExecute}
          onCancel={onCancel}
        />
      )}
    </Box>
  );
});

Console.displayName = "Console";

export default Console;
