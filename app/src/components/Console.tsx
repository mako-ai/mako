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
import { hashContent } from "../utils/hash";
import { useAppStore } from "../store/appStore";
import { useConsoleStore } from "../store/consoleStore";

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
  dbContentHash?: string;
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
  // Saved database values (for dirty tracking - only updated on save)
  savedConnectionId?: string;
  savedDatabaseId?: string;
  savedDatabaseName?: string;
  // Callbacks for database changes
  onDatabaseChange?: (connectionId: string) => void;
  onDatabaseNameChange?: (
    databaseId: string | undefined,
    databaseName: string | undefined,
  ) => void;
  filePath?: string;
  onHistoryClick?: () => void;
  enableVersionControl?: boolean;
  onSaveSuccess?: (newDbContentHash: string) => void;
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
    dbContentHash,
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
    // Saved database values (for dirty tracking)
    savedConnectionId,
    savedDatabaseId,
    savedDatabaseName,
    onDatabaseChange,
    onDatabaseNameChange,
    filePath,
    onHistoryClick,
    enableVersionControl = false,
    onSaveSuccess,
  } = props;

  const editorRef = useRef<any>(null);
  const diffEditorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { effectiveMode } = useTheme();
  const { currentWorkspace } = useWorkspace();
  const { saveDraftConsole } = useConsoleStore();

  // State for info modal
  const [infoModalOpen, setInfoModalOpen] = useState(false);

  // State to track if there are unsaved changes (content only)
  const [hasContentChanges, setHasContentChanges] = useState(false);
  const [monacoInstance, setMonacoInstance] = useState<any>(null);

  // Compute database dirty state from props (comparing current vs saved values)
  const hasDatabaseChanges = useMemo(() => {
    const connectionChanged = connectionId !== savedConnectionId;
    const dbIdChanged = databaseId !== savedDatabaseId;
    const dbNameChanged = databaseName !== savedDatabaseName;
    return connectionChanged || dbIdChanged || dbNameChanged;
  }, [
    connectionId,
    savedConnectionId,
    databaseId,
    savedDatabaseId,
    databaseName,
    savedDatabaseName,
  ]);

  // Combined dirty state - true if either content or database selection changed
  const hasUnsavedChanges = hasContentChanges || hasDatabaseChanges;

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
  const onSaveSuccessRef = useRef(onSaveSuccess);
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
    onSaveSuccessRef.current = onSaveSuccess;
  }, [onSaveSuccess]);

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
      // Matches: FROM `dataset.table` or FROM dataset.table or FROM table
      // Capture the full identifier sequence, stopping at whitespace, comma, semicolon, or parenthesis
      const tableRegex = /(?:FROM|JOIN)\s+([^\s,;()]+)(?:\s+AS\s+\w+)?/gi;
      let match;

      while ((match = tableRegex.exec(content)) !== null) {
        const fullMatch = match[0];
        const tableNameRaw = match[1];

        // Skip if it contains template variables or special chars that might indicate partial query
        if (tableNameRaw.includes("{") || tableNameRaw.includes("$")) continue;

        // Clean up backticks from the whole string or parts
        // Handle potentially complex backticking like `project`.`dataset`.table
        const cleanRaw = tableNameRaw.replace(/`/g, "");
        const parts = cleanRaw.split(".");

        let isValid = false;

        if (parts.length === 1) {
          // Just table name - check if it exists in any dataset
          const table = parts[0];
          for (const ds of Object.keys(schema)) {
            if (schema[ds][table]) {
              isValid = true;
              break;
            }
          }
        } else if (parts.length === 2) {
          // dataset.table
          const [ds, table] = parts;
          if (schema[ds] && schema[ds][table]) {
            isValid = true;
          }
        } else if (parts.length === 3) {
          // project.dataset.table - verify dataset and table
          // Note: schema keys are dataset names, we assume the second part is dataset
          const [_, ds, table] = parts;

          if (schema[ds] && schema[ds][table]) {
            isValid = true;
          }
        }

        if (!isValid && parts.length <= 3) {
          // Calculate position
          // We need to find the position of tableNameRaw within the full match to get accurate offset
          const tableIndex = fullMatch.indexOf(tableNameRaw);
          // Ensure indices are valid
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
      // Clear markers on unmount
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
    // In diff mode, get content from the modified editor
    if (isDiffMode) {
      const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
      if (modifiedEditor) {
        const selection = modifiedEditor.getSelection();
        const model = modifiedEditor.getModel();
        // If there's a non-empty selection, return only the selected text
        if (selection && !selection.isEmpty() && model) {
          return model.getValueInRange(selection);
        }
      }
      // Fall back to full modified content
      return modifiedContent || "";
    }

    // Normal mode: check for selection first
    if (editorRef.current) {
      const selection = editorRef.current.getSelection();
      const model = editorRef.current.getModel();
      // If there's a non-empty selection, return only the selected text
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
    // Use the latest ref values for execution (to avoid stale closures in Monaco commands)
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
      const success = await onSaveRef.current(content, filePathRef.current);

      // Only mark content as saved if the save actually succeeded
      if (success) {
        // Update dbContentHash via callback to mark content as saved
        const newContentHash = hashContent(content);
        if (onSaveSuccessRef.current) {
          onSaveSuccessRef.current(newContentHash);
        }
        // Also clear local dirty state since save succeeded
        setHasContentChanges(false);
      }
    }
  }, [getFullEditorContent]);

  // Calculate editor language
  const editorLanguage = useMemo(() => {
    if (filePath?.endsWith(".sql")) return "sql";
    if (filePath?.endsWith(".json")) return "json";
    if (filePath?.endsWith(".js") || filePath?.endsWith(".ts")) {
      return "javascript";
    }

    // Fallback to connection type
    const selectedDb = databases.find(db => db.id === connectionId);
    const dbType = selectedDb?.type;
    // Use most stable highlighter: javascript for MongoDB shell, sql otherwise
    return dbType === "mongodb" ? "javascript" : "sql";
  }, [filePath, databases, connectionId]);

  // Track the console ID to detect when we switch to a different console
  const lastConsoleIdRef = useRef(consoleId);

  useEffect(() => {
    // Only update content when switching to a different console
    if (consoleId !== lastConsoleIdRef.current) {
      lastConsoleIdRef.current = consoleId;

      if (!editorRef.current) {
        // Editor not mounted yet, force remount with new content
        setEditorKey(prev => prev + 1);
        return;
      }

      const model = editorRef.current.getModel();
      if (model) {
        // Only set value when switching consoles to preserve undo stack
        isProgrammaticUpdateRef.current = true;
        model.setValue(initialContent);
        isProgrammaticUpdateRef.current = false;

        // Move the cursor to the end of the newly inserted content
        const lineCount = model.getLineCount();
        const lastLineLength = model.getLineLength(lineCount);
        editorRef.current.setPosition({
          lineNumber: lineCount,
          column: lastLineLength + 1,
        });

        // Reset Monaco undo/redo state after setting new content
        setMonacoCanUndo(false);
        setMonacoCanRedo(false);
      }
    }
  }, [consoleId, initialContent]);

  // Apply new initialContent from props when background fetch finishes
  // Only overwrite if the editor is currently showing a placeholder or empty
  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;
    const current = model.getValue();
    const isPlaceholder = current === "loading..." || current.trim() === "";

    // If we have new content and current is placeholder/empty, update it
    if (isPlaceholder && initialContent && current !== initialContent) {
      isProgrammaticUpdateRef.current = true;
      model.setValue(initialContent);
      // Update undo/redo state
      setMonacoCanUndo(model.canUndo());
      setMonacoCanRedo(model.canRedo());
      // Update unsaved changes flag against DB hash
      if (dbContentHash) {
        const currentContentHash = hashContent(initialContent);
        const hasChanges = currentContentHash !== dbContentHash;
        setHasContentChanges(hasChanges);
      } else {
        setHasContentChanges(false);
      }
      isProgrammaticUpdateRef.current = false;
    }
  }, [initialContent, dbContentHash]);

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
      // Guard: Only execute if this console is the currently active one
      // This prevents executing a hidden console when focus wasn't properly transferred
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        // Get fresh state from store to check if this console is active
        const activeId = useAppStore.getState().consoles.activeTabId;
        if (activeId !== consoleId) {
          // Not the active console - don't execute
          // Focus should be transferred by Editor.tsx, but this is a safety check
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

      // Don't override Monaco's built-in undo/redo - it works perfectly!

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

        // Check initial content state
        const currentContent = model.getValue();
        const currentContentHash = hashContent(currentContent);
        const hasChanges =
          !dbContentHash || currentContentHash !== dbContentHash;
        setHasContentChanges(hasChanges);

        // Save initial version for undo history
        if (enableVersionControl && !hasInitialVersionRef.current) {
          saveUserEdit(currentContent, "Initial content");
          hasInitialVersionRef.current = true;
        }

        // Initialize Monaco undo/redo state
        setMonacoCanUndo(model.canUndo());
        setMonacoCanRedo(model.canRedo());
      }
    },
    // Note: consoleId is intentionally not in deps - it's stable for the lifetime of this component
    // and we want to capture it once when the editor mounts
    [
      enableVersionControl,
      setEditor,
      handleExecute,
      handleSave,
      onSave,
      dbContentHash,
      saveUserEdit,
      consoleId,
    ],
  );

  // Debounced content change notification for persistence (zustand + localStorage)
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const content = value || "";

      // Always check if content has changed from DB version (even for undo/redo)
      const currentContentHash = hashContent(content);
      const hasChanges = !dbContentHash || currentContentHash !== dbContentHash;
      setHasContentChanges(hasChanges);

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
        // Save version immediately on first change after a pause
        const shouldSaveImmediately = !debounceTimeoutRef.current;

        // Clear existing timeout
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }

        if (shouldSaveImmediately) {
          // Save immediately for the first keystroke after a pause
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
        }

        // Debounce subsequent saves
        debounceTimeoutRef.current = setTimeout(() => {
          saveUserEdit(content, "User edit");
          lastInitialContentRef.current = content;
          debounceTimeoutRef.current = null;
        }, 500); // Reduced to 500ms for better undo experience
      }

      // Normal content change callback
      if (onContentChange) {
        // Clear existing timeout
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }

        // Set new debounced timeout for persistence
        debounceTimeoutRef.current = setTimeout(() => {
          onContentChange(content);
        }, 500); // 500ms debounce for persistence
      }

      // Auto-save draft console when content changes (debounced internally)
      // This saves modified consoles to the database so they can be restored
      // when opening a chat from history
      if (hasChanges && currentWorkspace?.id && consoleId && content.trim()) {
        saveDraftConsole(
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
      dbContentHash,
      currentWorkspace?.id,
      consoleId,
      title,
      databaseName,
      saveDraftConsole,
    ],
  );

  // Calculate modified content based on the modification
  const calculateModifiedContent = useCallback(
    (current: string, modification: ConsoleModification): string => {
      switch (modification.action) {
        case "replace":
          return modification.content;

        case "append":
          return (
            current +
            (current.endsWith("\n") ? "" : "\n") +
            modification.content
          );

        case "insert": {
          if (!modification.position) {
            return modification.content + current;
          }

          const lines = current.split("\n");
          const { line, column } = modification.position;
          const lineIndex = line - 1;

          if (lineIndex >= 0 && lineIndex < lines.length) {
            const targetLine = lines[lineIndex];
            const before = targetLine.slice(0, column - 1);
            const after = targetLine.slice(column - 1);
            lines[lineIndex] = before + modification.content + after;
          }

          return lines.join("\n");
        }

        default:
          return current;
      }
    },
    [],
  );

  // Show diff instead of applying modification immediately
  const showDiff = useCallback(
    (modification: ConsoleModification) => {
      const currentContent = getFullEditorContent();
      const newContent = calculateModifiedContent(currentContent, modification);

      setOriginalContent(currentContent);
      setModifiedContent(newContent);
      setPendingModification(modification);
      setIsDiffMode(true);
    },
    [getFullEditorContent, calculateModifiedContent],
  );

  // Accept the changes
  const acceptChanges = useCallback(() => {
    if (pendingModification && modifiedContent) {
      // Exit diff mode first to restore the normal editor
      setIsDiffMode(false);

      // Force editor remount with new content by incrementing key
      setEditorKey(prev => prev + 1);

      // Store the modified content that will be used when editor mounts
      isProgrammaticUpdateRef.current = true;
      lastInitialContentRef.current = modifiedContent;

      // Clear the diff state
      const savedModifiedContent = modifiedContent;
      const savedOriginalContent = originalContent;
      const savedModification = pendingModification;

      setPendingModification(null);
      setOriginalContent("");
      setModifiedContent("");

      // Wait for editor to mount, then apply the content and save to history
      setTimeout(() => {
        if (editorRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            model.setValue(savedModifiedContent);

            // Save to version history using the hook functions
            if (enableVersionControl) {
              // The saveUserEdit function will handle version tracking
              saveUserEdit(savedOriginalContent, "Before AI modification");
              saveUserEdit(
                savedModifiedContent,
                `AI ${savedModification.action}`,
              );
            }

            // Notify content change
            if (onContentChange) {
              onContentChange(savedModifiedContent);
            }

            // Mark as having unsaved changes since AI modified the content
            const currentContentHash = hashContent(savedModifiedContent);
            const hasChanges =
              !dbContentHash || currentContentHash !== dbContentHash;
            setHasContentChanges(hasChanges);
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
    dbContentHash,
  ]);

  // Reject the changes
  const rejectChanges = useCallback(() => {
    // Simply exit diff mode without applying changes
    setIsDiffMode(false);
    setPendingModification(null);
    setOriginalContent("");
    setModifiedContent("");
  }, []);

  // DiffEditor mount handler - set up CMD+Enter and store ref
  const handleDiffEditorDidMount = useCallback(
    (diffEditor: any, monaco: any) => {
      diffEditorRef.current = diffEditor;

      // Get the modified editor to add keyboard shortcuts
      const modifiedEditor = diffEditor.getModifiedEditor();
      if (modifiedEditor) {
        // CMD/CTRL + Enter execution support
        modifiedEditor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
          () => {
            // Use refs to get latest values
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
                        // Update undo/redo state after action
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
                        // Update undo/redo state after action
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
                    // Call parent callback directly (unidirectional flow)
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
