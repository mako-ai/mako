import {
  useRef,
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
} from "react";
import {
  Box,
  Button,
  Select,
  MenuItem,
  FormControl,
  Tooltip,
  IconButton,
  Divider,
  Badge,
  Alert,
} from "@mui/material";
import { PlayArrow as PlayIcon } from "@mui/icons-material";
import {
  Check as CheckIcon,
  X as CloseIcon,
  Save as SaveIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
  History as HistoryIcon,
  Info as InfoOutlineIcon,
  Square as StopIcon,
} from "lucide-react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "../contexts/ThemeContext";
import { useWorkspace } from "../contexts/workspace-context";
import { useSchemaStore, TreeNode } from "../store/schemaStore";
import {
  useMonacoConsole,
  ConsoleModification,
} from "../hooks/useMonacoConsole";
import ConsoleInfoModal from "./ConsoleInfoModal";
import { useConsoleStore } from "../store/consoleStore";
import { computeConsoleStateHash } from "../utils/stateHash";
import { applyModification as applyConsoleModification } from "../utils/consoleModification";

interface DatabaseConnection {
  id: string;
  connectionId?: string; // Optional for backward compatibility
  name: string;
  description: string;
  database: string;
  databaseName?: string;
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  isClusterMode?: boolean; // Optional for backward compatibility
  displayName: string;
  hostKey: string;
  hostName: string;
}

interface ConsoleProps {
  consoleId: string;
  initialContent: string;
  title?: string;
  onExecute: (
    content: string,
    connectionId?: string,
    databaseId?: string, // Sub-database ID for cluster mode (e.g., D1 UUID)
  ) => void;
  onCancel?: () => void;
  onSave?: (content: string, currentPath?: string) => Promise<boolean>;
  isExecuting: boolean;
  isCancelling?: boolean;
  isSaving?: boolean;
  onContentChange?: (content: string) => void;
  databases?: DatabaseConnection[];
  // Current database selection (from store, single source of truth)
  connectionId?: string;
  databaseId?: string; // D1 database UUID for cluster mode
  databaseName?: string; // D1 database human-readable name for cluster mode
  // Callbacks for database changes
  onDatabaseChange?: (connectionId: string) => void;
  onDatabaseNameChange?: (
    databaseId: string | undefined,
    databaseName: string | undefined,
  ) => void;
  filePath?: string;
  onHistoryClick?: () => void;
  enableVersionControl?: boolean;
}

export interface ConsoleRef {
  getCurrentContent: () => {
    content: string;
    fileName?: string;
    language?: string;
  };
  applyModification: (modification: ConsoleModification) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  showDiff: (modification: ConsoleModification) => void;
  focus: () => void;
}

const Console = forwardRef<ConsoleRef, ConsoleProps>((props, ref) => {
  const {
    consoleId,
    initialContent,
    title,
    onExecute,
    onCancel,
    onSave,
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
    enableVersionControl = false,
  } = props;

  const editorRef = useRef<any>(null);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { effectiveMode } = useTheme();
  const { currentWorkspace } = useWorkspace();
  const autoSaveConsole = useConsoleStore(state => state.autoSaveConsole);
  const tabs = useConsoleStore(state => state.tabs);

  // Get tab state for savedStateHash (used for dirty tracking)
  const tab = tabs[consoleId];
  const savedStateHash = tab?.savedStateHash;
  const isSaved = tab?.isSaved ?? false;

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

  // State for diff mode
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [originalContent, setOriginalContent] = useState("");
  const [modifiedContent, setModifiedContent] = useState("");
  const [pendingModification, setPendingModification] =
    useState<ConsoleModification | null>(null);

  // Editor key to force remount when needed
  const [editorKey, setEditorKey] = useState(0);

  // Refs for tracking state without triggering re-renders
  const isProgrammaticUpdateRef = useRef(false);
  const lastInitialContentRef = useRef(initialContent);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const filePathRef = useRef(filePath);
  const monacoRef = useRef<any>(null);

  // Update filePathRef when props change
  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

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
    getHistory,
    saveUserEdit,
    isApplyingModification,
  } = useMonacoConsole({
    consoleId,
    onContentChange: enableVersionControl ? onContentChange : undefined,
  });

  // Track if we've saved the initial version
  const hasInitialVersionRef = useRef(false);

  // Reset initial version flag when console changes
  useEffect(() => {
    hasInitialVersionRef.current = false;
  }, [consoleId]);

  // Keep refs of the latest callbacks and props to avoid stale closures in Monaco commands
  const onExecuteRef = useRef(onExecute);
  const onSaveRef = useRef(onSave);
  const connectionIdRef = useRef(connectionId);
  const databaseIdRef = useRef(databaseId);

  // Update refs whenever the callbacks/props change
  useEffect(() => {
    onExecuteRef.current = onExecute;
  }, [onExecute]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    connectionIdRef.current = connectionId;
    databaseIdRef.current = databaseId;
  }, [connectionId, databaseId]);

  // Handler for connection selection change - calls parent callback directly (unidirectional flow)
  const handleDatabaseSelection = useCallback(
    (event: any) => {
      const newConnectionId = event.target.value;
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
    [onDatabaseChange, onDatabaseNameChange, databases],
  );

  // Derived state for databases
  const selectedConnection = useMemo(
    () => databases.find(db => db.id === connectionId),
    [databases, connectionId],
  );

  // Get available databases (sub-databases for cluster mode) from tree nodes
  const availableDatabases: TreeNode[] = useMemo(() => {
    if (!connectionId) return [];
    const rootNodes = treeNodes[connectionId]?.["root"] || [];
    // For cluster mode, root nodes are databases
    return rootNodes;
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

  // SQL autocomplete is now handled at the Editor level (single global provider)

  // Debounced validation for error highlighting
  useEffect(() => {
    if (!monacoInstance || !connectionId || !editorRef.current) return;

    const schema = autocompleteSchemas[connectionId];
    if (!schema) return;

    // Use a separate timeout ref for validation so we don't interfere with the main save/undo debounce
    const validationTimeoutRef = { current: null as NodeJS.Timeout | null };

    const validateContent = () => {
      const model = editorRef.current?.getModel();
      if (!model) return;

      const content = model.getValue();
      const markers: any[] = [];

      // Simple regex to find table references in FROM/JOIN clauses
      const tableRegex = /(?:FROM|JOIN)\s+([^\s,;()]+)(?:\s+AS\s+\w+)?/gi;
      let match;

      while ((match = tableRegex.exec(content)) !== null) {
        const fullMatch = match[0];
        const tableNameRaw = match[1];

        // Skip if it contains template variables or special chars
        if (tableNameRaw.includes("{") || tableNameRaw.includes("$")) continue;

        const cleanRaw = tableNameRaw.replace(/`/g, "");
        const parts = cleanRaw.split(".");

        let isValid = false;

        if (parts.length === 1) {
          const table = parts[0];
          for (const ds of Object.keys(schema)) {
            if (schema[ds][table]) {
              isValid = true;
              break;
            }
          }
        } else if (parts.length === 2) {
          const [ds, table] = parts;
          if (schema[ds] && schema[ds][table]) {
            isValid = true;
          }
        } else if (parts.length === 3) {
          const [_, ds, table] = parts;
          if (schema[ds] && schema[ds][table]) {
            isValid = true;
          }
        }

        if (!isValid && parts.length <= 3) {
          const tableIndex = fullMatch.indexOf(tableNameRaw);
          if (tableIndex !== -1) {
            const startPos = model.getPositionAt(match.index + tableIndex);
            const endPos = model.getPositionAt(
              match.index + tableIndex + tableNameRaw.length,
            );

            markers.push({
              severity: monacoInstance.MarkerSeverity.Warning,
              startLineNumber: startPos.lineNumber,
              startColumn: startPos.column,
              endLineNumber: endPos.lineNumber,
              endColumn: endPos.column,
              message: `Table '${cleanRaw}' not found in schema`,
            });
          }
        }
      }

      monacoInstance.editor.setModelMarkers(model, "sql-validation", markers);
    };

    // Run validation initially
    validateContent();

    // Set up debounced validation on change
    const disposer = editorRef.current.onDidChangeModelContent(() => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      validationTimeoutRef.current = setTimeout(validateContent, 1000);
    });

    return () => {
      disposer.dispose();
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current);
      }
      const model = editorRef.current?.getModel();
      if (model) {
        monacoInstance.editor.setModelMarkers(model, "sql-validation", []);
      }
    };
  }, [connectionId, autocompleteSchemas, monacoInstance]);

  // Helper function to get full editor content (ignores selection)
  const getFullEditorContent = useCallback(() => {
    if (isDiffMode) {
      return modifiedContent || "";
    }
    return editorRef.current?.getValue() || "";
  }, [isDiffMode, modifiedContent]);

  // Helper function to get content for execution (selected text if there's a selection, otherwise full content)
  const getExecutionContent = useCallback(() => {
    if (isDiffMode) {
      const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
      if (modifiedEditor) {
        const selection = modifiedEditor.getSelection();
        const model = modifiedEditor.getModel();
        if (selection && !selection.isEmpty() && model) {
          return model.getValueInRange(selection);
        }
      }
      return modifiedContent || "";
    }

    if (editorRef.current) {
      const selection = editorRef.current.getSelection();
      const model = editorRef.current.getModel();
      if (selection && !selection.isEmpty() && model) {
        return model.getValueInRange(selection);
      }
      return editorRef.current.getValue() || "";
    }
    return "";
  }, [isDiffMode, modifiedContent]);

  // Handler for opening info modal
  const handleInfoClick = useCallback(() => {
    setInfoModalOpen(true);
  }, []);

  // Handler for closing info modal
  const handleInfoModalClose = useCallback(() => {
    setInfoModalOpen(false);
  }, []);

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
  }, [getExecutionContent]);

  // Save handler - always saves full content regardless of selection
  const handleSave = useCallback(async () => {
    if (onSaveRef.current) {
      const content = getFullEditorContent();
      await onSaveRef.current(content, filePathRef.current);
      // Editor.tsx handles updating savedStateHash on success
    }
  }, [getFullEditorContent]);

  // Calculate editor language
  const editorLanguage = useMemo(() => {
    if (filePath?.endsWith(".sql")) return "sql";
    if (filePath?.endsWith(".json")) return "json";
    if (filePath?.endsWith(".js") || filePath?.endsWith(".ts")) {
      return "javascript";
    }

    const selectedDb = databases.find(db => db.id === connectionId);
    const dbType = selectedDb?.type;
    return dbType === "mongodb" ? "javascript" : "sql";
  }, [filePath, databases, connectionId]);

  // Track the console ID to detect when we switch to a different console
  const lastConsoleIdRef = useRef(consoleId);

  useEffect(() => {
    if (consoleId !== lastConsoleIdRef.current) {
      lastConsoleIdRef.current = consoleId;

      if (!editorRef.current) {
        setEditorKey(prev => prev + 1);
        return;
      }

      const model = editorRef.current.getModel();
      if (model) {
        isProgrammaticUpdateRef.current = true;
        model.setValue(initialContent);
        isProgrammaticUpdateRef.current = false;

        const lineCount = model.getLineCount();
        const lastLineLength = model.getLineLength(lineCount);
        editorRef.current.setPosition({
          lineNumber: lineCount,
          column: lastLineLength + 1,
        });

        setMonacoCanUndo(false);
        setMonacoCanRedo(false);
      }
    }
  }, [consoleId, initialContent]);

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
      setMonacoCanUndo(model.canUndo());
      setMonacoCanRedo(model.canRedo());
      isProgrammaticUpdateRef.current = false;
    }
  }, [initialContent]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const handleEditorDidMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      setMonacoInstance(monaco);

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

      // Auto-focus the editor when it mounts
      editor.focus();

      // Position cursor at the end of the content
      const model = editor.getModel();
      if (model) {
        const lineCount = model.getLineCount();
        const lastLineLength = model.getLineLength(lineCount);
        editor.setPosition({
          lineNumber: lineCount,
          column: lastLineLength + 1,
        });

        const currentContent = model.getValue();

        // Auto-save new consoles created with content (e.g., by agent create_console)
        // Skip if console is already explicitly saved (isSaved=true)
        if (
          !isSaved &&
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

        setMonacoCanUndo(model.canUndo());
        setMonacoCanRedo(model.canRedo());
      }
    },
    [
      enableVersionControl,
      setEditor,
      handleExecute,
      handleSave,
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
    ],
  );

  // Debounced content change notification for persistence (zustand + localStorage)
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const content = value || "";

      // Update Monaco undo/redo state
      if (editorRef.current) {
        const model = editorRef.current.getModel();
        if (model) {
          setMonacoCanUndo(model.canUndo());
          setMonacoCanRedo(model.canRedo());
        }
      }

      // Skip the rest if this is a programmatic update (to prevent feedback loops)
      if (isProgrammaticUpdateRef.current) {
        return;
      }

      // Save user edit to version history if version control is enabled
      if (
        enableVersionControl &&
        content !== lastInitialContentRef.current &&
        !isApplyingModification.current
      ) {
        const shouldSaveImmediately = !debounceTimeoutRef.current;

        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }

        if (shouldSaveImmediately) {
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
        }

        debounceTimeoutRef.current = setTimeout(() => {
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
          debounceTimeoutRef.current = null;
        }, 500);
      }

      // Normal content change callback
      if (onContentChange) {
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }

        debounceTimeoutRef.current = setTimeout(() => {
          onContentChange(content);
        }, 500);
      }

      // Auto-save console when content changes (debounced internally by autoSaveConsole)
      // Skip if console is already explicitly saved (isSaved=true)
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
      onContentChange,
      enableVersionControl,
      saveUserEdit,
      isApplyingModification,
      currentWorkspace?.id,
      consoleId,
      title,
      databaseName,
      isSaved,
      autoSaveConsole,
    ],
  );

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

      setModifiedContent(newContent);
      setPendingModification(modification);
      setIsDiffMode(true);
    },
    [getFullEditorContent, isDiffMode],
  );

  // Accept the changes
  const acceptChanges = useCallback(() => {
    if (pendingModification && modifiedContent) {
      setIsDiffMode(false);
      setEditorKey(prev => prev + 1);

      isProgrammaticUpdateRef.current = true;
      lastInitialContentRef.current = modifiedContent;

      const savedModifiedContent = modifiedContent;
      const savedOriginalContent = originalContent;
      const savedModification = pendingModification;

      setPendingModification(null);
      setOriginalContent("");
      setModifiedContent("");

      setTimeout(() => {
        if (editorRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            model.setValue(savedModifiedContent);

            if (enableVersionControl) {
              saveUserEdit(savedOriginalContent, "Before AI modification");
              saveUserEdit(
                savedModifiedContent,
                `AI ${savedModification.action}`,
              );
            }

            if (onContentChange) {
              onContentChange(savedModifiedContent);
            }

            // Auto-save agent modifications (debounced internally)
            // Skip if console is already explicitly saved (isSaved=true)
            if (
              !isSaved &&
              currentWorkspace?.id &&
              consoleId &&
              savedModifiedContent.trim()
            ) {
              autoSaveConsole(
                currentWorkspace.id,
                consoleId,
                savedModifiedContent,
                title,
                connectionIdRef.current,
                databaseIdRef.current,
                databaseName,
              );
            }
          }
        }
        isProgrammaticUpdateRef.current = false;
      }, 100);
    }
  }, [
    pendingModification,
    modifiedContent,
    originalContent,
    onContentChange,
    enableVersionControl,
    saveUserEdit,
    currentWorkspace,
    consoleId,
    title,
    databaseName,
    isSaved,
    autoSaveConsole,
  ]);

  // Reject the changes and restore the original baseline
  const rejectChanges = useCallback(() => {
    // Restore editor content to original baseline and sync store
    if (originalContent && onContentChange) {
      onContentChange(originalContent);
    }

    setIsDiffMode(false);
    setPendingModification(null);
    setOriginalContent("");
    setModifiedContent("");
  }, [originalContent, onContentChange]);

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
    [getExecutionContent],
  );

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
      undo,
      redo,
      canUndo,
      canRedo,
      showDiff,
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
      undo,
      redo,
      canUndo,
      canRedo,
      showDiff,
      isDiffMode,
    ],
  );

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: "background.paper",
          p: 0.5,
          gap: 0.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {isExecuting ? (
            <Button
              variant="contained"
              size="small"
              color="error"
              startIcon={<StopIcon size={18} />}
              onClick={onCancel}
              disabled={isCancelling}
              disableElevation
              sx={{ minWidth: "120px" }}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </Button>
          ) : (
            <Tooltip
              title={
                !connectionId
                  ? "Select a database connection to run queries"
                  : ""
              }
            >
              <span>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<PlayIcon />}
                  onClick={handleExecute}
                  disabled={!connectionId}
                  disableElevation
                  sx={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "200px",
                    minWidth: "120px",
                  }}
                >
                  Run (⌘/Ctrl+Enter)
                </Button>
              </span>
            </Tooltip>
          )}

          {onSave && (
            <Tooltip
              title={
                !hasUnsavedChanges
                  ? "No changes to save"
                  : filePathRef.current
                    ? "Save (⌘/Ctrl+S)"
                    : "Save As... (⌘/Ctrl+S)"
              }
            >
              <IconButton
                size="small"
                onClick={handleSave}
                disabled={isSaving || isExecuting || !hasUnsavedChanges}
                sx={{
                  ml: 1,
                }}
              >
                <SaveIcon strokeWidth={2} size={22} />
              </IconButton>
            </Tooltip>
          )}

          {enableVersionControl && (
            <>
              <Divider orientation="vertical" flexItem />

              <Tooltip title="Undo (⌘/Ctrl+Z)">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => {
                      if (editorRef.current) {
                        editorRef.current.trigger("keyboard", "undo", null);
                        setTimeout(() => {
                          const model = editorRef.current?.getModel();
                          if (model) {
                            setMonacoCanUndo(model.canUndo());
                            setMonacoCanRedo(model.canRedo());
                          }
                        }, 0);
                      }
                    }}
                    disabled={isDiffMode || !monacoCanUndo}
                  >
                    <UndoIcon strokeWidth={2} size={22} />
                  </IconButton>
                </span>
              </Tooltip>

              <Tooltip title="Redo (⌘/Ctrl+Shift+Z)">
                <span>
                  <IconButton
                    size="small"
                    onClick={() => {
                      if (editorRef.current) {
                        editorRef.current.trigger("keyboard", "redo", null);
                        setTimeout(() => {
                          const model = editorRef.current?.getModel();
                          if (model) {
                            setMonacoCanUndo(model.canUndo());
                            setMonacoCanRedo(model.canRedo());
                          }
                        }, 0);
                      }
                    }}
                    disabled={isDiffMode || !monacoCanRedo}
                  >
                    <RedoIcon strokeWidth={2} size={22} />
                  </IconButton>
                </span>
              </Tooltip>

              {onHistoryClick && (
                <Tooltip title="Version History">
                  <IconButton
                    size="small"
                    onClick={onHistoryClick}
                    disabled={isDiffMode}
                  >
                    <Badge
                      badgeContent={getHistory().length}
                      color="primary"
                      max={99}
                    >
                      <HistoryIcon strokeWidth={2} size={22} />
                    </Badge>
                  </IconButton>
                </Tooltip>
              )}
            </>
          )}
          <Divider orientation="vertical" flexItem />
          <IconButton onClick={handleInfoClick} size="small">
            <InfoOutlineIcon strokeWidth={2} size={22} />
          </IconButton>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Connection selector */}
          <FormControl
            size="small"
            variant="standard"
            sx={{ minWidth: 80, m: 0, p: 0 }}
          >
            <Select
              variant="standard"
              disableUnderline
              labelId="database-select-label"
              value={connectionId || ""}
              onChange={handleDatabaseSelection}
              disabled={databases.length === 0}
            >
              {databases.length === 0 ? (
                <MenuItem value="" disabled>
                  No connections available
                </MenuItem>
              ) : (
                databases.map(db => (
                  <MenuItem key={db.id} value={db.id}>
                    {db.displayName || db.name || "Unknown Connection"}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>

          {/* Database selector (only shown for cluster mode connections) */}
          {selectedConnection?.isClusterMode && (
            <>
              <Divider orientation="vertical" flexItem />
              <FormControl
                size="small"
                variant="standard"
                sx={{ minWidth: 80, m: 0, p: 0 }}
              >
                <Select
                  variant="standard"
                  disableUnderline
                  labelId="database-name-select-label"
                  value={databaseId || ""}
                  onChange={e => {
                    const dbId = e.target.value || undefined;
                    const db = availableDatabases.find(d => d.id === dbId);
                    if (onDatabaseNameChange) {
                      onDatabaseNameChange(dbId, db?.label);
                    }
                  }}
                  disabled={
                    isLoadingDatabases || availableDatabases.length === 0
                  }
                  displayEmpty
                >
                  {isLoadingDatabases ? (
                    <MenuItem value="" disabled>
                      Loading...
                    </MenuItem>
                  ) : availableDatabases.length === 0 ? (
                    <MenuItem value="" disabled>
                      No databases
                    </MenuItem>
                  ) : (
                    availableDatabases.map(db => (
                      <MenuItem key={db.id} value={db.id}>
                        {db.label || db.id}
                      </MenuItem>
                    ))
                  )}
                </Select>
              </FormControl>
            </>
          )}
        </Box>
      </Box>

      {/* Diff mode action bar - shown below the main toolbar */}
      {isDiffMode && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 1,
            pb: 1,
            backgroundColor: "background.paper",
            gap: 0.5,
            justifyContent: "space-between",
          }}
        >
          <Alert
            severity="info"
            sx={{
              p: 0,
              pl: 1,
              pr: 2,
              "& .MuiAlert-icon": {
                fontSize: "1.25rem",
              },
            }}
          >
            AI suggested changes - Review the diff below
          </Alert>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
            <Button
              variant="contained"
              color="success"
              size="small"
              startIcon={<CheckIcon strokeWidth={2} size={22} />}
              onClick={acceptChanges}
              disableElevation
            >
              Accept
            </Button>
            <Button
              variant="outlined"
              color="error"
              size="small"
              startIcon={<CloseIcon strokeWidth={2} size={22} />}
              onClick={rejectChanges}
              disableElevation
            >
              Reject
            </Button>
          </Box>
        </Box>
      )}

      <Box ref={containerRef} sx={{ flexGrow: 1, height: 0 }}>
        {!isDiffMode ? (
          <Editor
            key={editorKey}
            language={editorLanguage || "javascript"}
            defaultValue={lastInitialContentRef.current || initialContent}
            height="100%"
            theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            options={{
              automaticLayout: true,
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <DiffEditor
            height="100%"
            theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
            language={editorLanguage || "javascript"}
            original={originalContent}
            modified={modifiedContent}
            onMount={handleDiffEditorDidMount}
            options={{
              automaticLayout: true,
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              renderSideBySide: false,
              enableSplitViewResizing: false,
              diffWordWrap: "on",
            }}
          />
        )}
      </Box>

      {/* Info Modal */}
      <ConsoleInfoModal
        open={infoModalOpen}
        onClose={handleInfoModalClose}
        consoleId={consoleId}
        workspaceId={currentWorkspace?.id}
      />
    </Box>
  );
});

Console.displayName = "Console";

export default Console;
