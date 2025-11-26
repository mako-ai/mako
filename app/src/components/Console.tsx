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
} from "lucide-react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "../contexts/ThemeContext";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useMonacoConsole,
  ConsoleModification,
} from "../hooks/useMonacoConsole";
import ConsoleInfoModal from "./ConsoleInfoModal";
import { hashContent } from "../utils/hash";

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

interface DatabaseTreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren: boolean;
  metadata?: Record<string, any>;
}

interface ConsoleProps {
  consoleId: string;
  initialContent: string;
  dbContentHash?: string;
  title?: string;
  onExecute: (content: string, databaseId?: string, databaseName?: string) => void;
  onSave?: (content: string, currentPath?: string) => Promise<boolean>;
  isExecuting: boolean;
  isSaving?: boolean;
  onContentChange?: (content: string) => void;
  databases?: DatabaseConnection[];
  initialDatabaseId?: string;
  initialSelectedDatabaseId?: string; // D1 database UUID for cluster mode
  initialSelectedDatabaseName?: string; // D1 database human-readable name for cluster mode
  onDatabaseChange?: (databaseId: string) => void;
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
}

const Console = forwardRef<ConsoleRef, ConsoleProps>((props, ref) => {
  const {
    consoleId,
    initialContent,
    dbContentHash,
    title,
    onExecute,
    onSave,
    isExecuting,
    isSaving,
    onContentChange,
    databases = [],
    initialDatabaseId,
    initialSelectedDatabaseId,
    initialSelectedDatabaseName,
    onDatabaseChange,
    onDatabaseNameChange,
    filePath,
    onHistoryClick,
    enableVersionControl = false,
    onSaveSuccess,
  } = props;

  const editorRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { effectiveMode } = useTheme();
  const { currentWorkspace } = useWorkspace();

  // State for info modal
  const [infoModalOpen, setInfoModalOpen] = useState(false);

  // State to track if there are unsaved changes
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // State to track Monaco's undo/redo availability
  const [monacoCanUndo, setMonacoCanUndo] = useState(false);
  const [monacoCanRedo, setMonacoCanRedo] = useState(false);

  // State for sub-database selection (cluster mode - second dropdown, e.g., D1 databases)
  const [selectedSubDbId, setSelectedSubDbId] = useState<string | undefined>(initialSelectedDatabaseId);
  const [selectedSubDbName, setSelectedSubDbName] = useState<string | undefined>(initialSelectedDatabaseName);
  const [availableDatabases, setAvailableDatabases] = useState<DatabaseTreeNode[]>([]);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(false);

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

  // Track if user has manually selected a database
  const hasUserSelectedDatabaseRef = useRef(false);

  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string>(() => {
    // Initialize with initialDatabaseId or first database or empty string
    if (initialDatabaseId) return initialDatabaseId;
    if (databases.length > 0) return databases[0].id;
    return "";
  });

  // Keep refs of the latest callbacks to avoid stale closures in Monaco commands
  const onExecuteRef = useRef(onExecute);
  const onSaveRef = useRef(onSave);
  const filePathRef = useRef<string | undefined>(filePath);

  // Determine editor language based on selected database type if available
  const editorLanguage = useMemo(() => {
    const selectedDb = databases.find(db => db.id === selectedDatabaseId);
    const dbType = selectedDb?.type;
    // Use most stable highlighter: javascript for MongoDB shell, sql otherwise
    return dbType === "mongodb" ? "javascript" : "sql";
  }, [databases, selectedDatabaseId]);

  // Update refs whenever the callbacks change
  useEffect(() => {
    onExecuteRef.current = onExecute;
  }, [onExecute]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Persist last known file path so subsequent saves don't downgrade to "Save As"
  useEffect(() => {
    if (filePath) {
      filePathRef.current = filePath;
    }
  }, [filePath]);

  // Diff mode state
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [pendingModification, setPendingModification] =
    useState<ConsoleModification | null>(null);
  const [originalContent, setOriginalContent] = useState("");
  const [modifiedContent, setModifiedContent] = useState("");

  // Only track the initial content for resetting the editor when needed
  const [editorKey, setEditorKey] = useState(0);

  // Track if we're programmatically updating content to avoid feedback loops
  const isProgrammaticUpdateRef = useRef(false);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastInitialContentRef = useRef(initialContent);

  // Keep a ref of the latest selected database so closures (e.g. Monaco keybindings) always see the up-to-date value
  const selectedDatabaseIdRef = useRef<string>(selectedDatabaseId);
  const selectedSubDbIdRef = useRef<string | undefined>(selectedSubDbId);
  const selectedSubDbNameRef = useRef<string | undefined>(selectedSubDbName);

  // Whenever selectedDatabaseId changes, update the ref
  useEffect(() => {
    selectedDatabaseIdRef.current = selectedDatabaseId;
  }, [selectedDatabaseId]);

  // Whenever sub-database selection changes, update refs and notify parent
  useEffect(() => {
    selectedSubDbIdRef.current = selectedSubDbId;
    selectedSubDbNameRef.current = selectedSubDbName;
    if (onDatabaseNameChange) {
      onDatabaseNameChange(selectedSubDbId, selectedSubDbName);
    }
  }, [selectedSubDbId, selectedSubDbName, onDatabaseNameChange]);

  // Sync sub-database selection with initial values when they change
  useEffect(() => {
    setSelectedSubDbId(initialSelectedDatabaseId);
    setSelectedSubDbName(initialSelectedDatabaseName);
  }, [initialSelectedDatabaseId, initialSelectedDatabaseName]);

  // Get current selected connection to check if it's in cluster mode
  const selectedConnection = useMemo(() => {
    return databases.find(db => db.id === selectedDatabaseId);
  }, [databases, selectedDatabaseId]);

  // Fetch available databases when a cluster mode connection is selected
  useEffect(() => {
    const fetchDatabases = async () => {
      if (!selectedConnection?.isClusterMode || !currentWorkspace?.id || !selectedDatabaseId) {
        setAvailableDatabases([]);
        return;
      }

      setIsLoadingDatabases(true);
      try {
        const response = await fetch(
          `/api/workspaces/${currentWorkspace.id}/databases/${selectedDatabaseId}/tree`,
          { credentials: "include" }
        );
        const data = await response.json();
        if (data.success && data.data) {
          setAvailableDatabases(data.data);
          // Auto-select first database if none selected and databases available
          if (!selectedSubDbId && data.data.length > 0) {
            const firstDb = data.data[0];
            setSelectedSubDbId(firstDb.id);
            setSelectedSubDbName(firstDb.label);
          }
        }
      } catch (err) {
        console.error("Failed to fetch databases for connection:", err);
        setAvailableDatabases([]);
      } finally {
        setIsLoadingDatabases(false);
      }
    };

    fetchDatabases();
  }, [selectedConnection?.isClusterMode, selectedDatabaseId, currentWorkspace?.id]);

  // Memoize the default database ID to prevent unnecessary re-calculations
  const defaultDatabaseId = useMemo(() => {
    if (initialDatabaseId) return initialDatabaseId;
    if (databases.length > 0) return databases[0].id;
    return "";
  }, [initialDatabaseId, databases]);

  // On first load (or when the list of databases changes) pick a sensible
  // default connection **only** if the user hasn't interacted with the
  // dropdown yet.
  useEffect(() => {
    if (
      !hasUserSelectedDatabaseRef.current &&
      !selectedDatabaseId &&
      defaultDatabaseId
    ) {
      setSelectedDatabaseId(defaultDatabaseId);
    }
  }, [defaultDatabaseId, selectedDatabaseId]);

  // Sync the selected database with the incoming prop **only** when the user
  // has **not** explicitly chosen a connection. This prevents the dropdown
  // from constantly "blinking" back to the prop-driven value after every
  // keystroke or parent re-render.
  useEffect(() => {
    if (!initialDatabaseId) return; // ignore empty values

    // If the parent changed the default database (e.g., because we switched
    // files/tabs) and the user hasn't made a manual choice yet, adopt it.
    if (!hasUserSelectedDatabaseRef.current) {
      setSelectedDatabaseId(initialDatabaseId);
    }
  }, [initialDatabaseId]);

  // Notify parent whenever selectedDatabaseId changes (with debouncing to prevent loops)
  const handleDatabaseChange = useCallback(
    (databaseId: string) => {
      if (onDatabaseChange && databaseId) {
        onDatabaseChange(databaseId);
      }
    },
    [onDatabaseChange],
  );

  useEffect(() => {
    if (selectedDatabaseId) {
      handleDatabaseChange(selectedDatabaseId);
    }
  }, [selectedDatabaseId, handleDatabaseChange]);

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

  // Reset unsaved changes when dbContentHash changes (new DB version loaded)
  useEffect(() => {
    if (dbContentHash) {
      // When we have a new DB hash, check if current content matches it
      if (editorRef.current) {
        const model = editorRef.current.getModel();
        if (model) {
          const currentContent = model.getValue();
          const currentContentHash = hashContent(currentContent);
          const hasChanges = currentContentHash !== dbContentHash;
          setHasUnsavedChanges(hasChanges);
        }
      } else {
        // Editor not mounted yet, assume no changes
        setHasUnsavedChanges(false);
      }
    }
  }, [dbContentHash]);

  // Apply new initialContent from props when background fetch finishes
  // Only overwrite if the editor is currently showing a placeholder or empty
  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;
    const current = model.getValue();
    const isPlaceholder = current === "loading..." || current.trim() === "";
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
        setHasUnsavedChanges(hasChanges);
      } else {
        setHasUnsavedChanges(false);
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

  // Resize handling for monaco layout
  useEffect(() => {
    const handleResize = () => {
      if (editorRef.current) {
        editorRef.current.layout();
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Get current content from editor
  const getCurrentEditorContent = useCallback(() => {
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        return model.getValue();
      }
    }
    return initialContent;
  }, [initialContent]);

  // Execute helper
  const executeContent = useCallback(
    (content: string) => {
      if (content.trim()) {
        onExecuteRef.current(
          content,
          selectedDatabaseIdRef.current || undefined,
          selectedSubDbIdRef.current, // D1 database UUID for cluster mode
        );
      }
    },
    [], // Remove onExecute from dependencies since we're using the ref
  );

  const handleSave = useCallback(async () => {
    if (onSave) {
      // If in diff mode, save the modified content
      const content =
        isDiffMode && modifiedContent
          ? modifiedContent
          : getCurrentEditorContent();
      const success = await onSave(content, filePathRef.current);

      // Reset unsaved changes flag if save was successful
      if (success) {
        setHasUnsavedChanges(false);

        // Notify parent of the new DB content hash
        if (onSaveSuccess) {
          const newDbContentHash = hashContent(content);
          onSaveSuccess(newDbContentHash);
        }
      }
      // Parent component is responsible for feedback (e.g., snackbar, error modal)
    }
  }, [
    onSave,
    getCurrentEditorContent,
    filePath,
    isDiffMode,
    modifiedContent,
    onSaveSuccess,
  ]);

  const handleExecute = useCallback(() => {
    // If in diff mode, execute the modified content
    if (isDiffMode && modifiedContent) {
      executeContent(modifiedContent);
      return;
    }

    // Prefer executing the currently selected text, if any, otherwise run the entire editor content
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        const selection = editorRef.current.getSelection();
        let textToExecute = "";

        if (selection && !selection.isEmpty()) {
          textToExecute = model.getValueInRange(selection);
        } else {
          textToExecute = model.getValue();
        }

        executeContent(textToExecute);
        return;
      }
    }

    // Fallback: execute the initial content
    executeContent(initialContent);
  }, [executeContent, initialContent, isDiffMode, modifiedContent]);

  const handleDatabaseSelection = useCallback((event: any) => {
    const newDatabaseId = event.target.value;
    hasUserSelectedDatabaseRef.current = true; // Mark that user has manually selected
    setSelectedDatabaseId(newDatabaseId);
    // Clear sub-database selection when switching connections
    setSelectedSubDbId(undefined);
    setSelectedSubDbName(undefined);
    setAvailableDatabases([]);
  }, []);

  // No need to wrap undo/redo - they will trigger content change which updates hasUnsavedChanges

  // Handler for opening info modal
  const handleInfoClick = useCallback(() => {
    setInfoModalOpen(true);
  }, []);

  // Handler for closing info modal
  const handleInfoModalClose = useCallback(() => {
    setInfoModalOpen(false);
  }, []);

  const handleEditorDidMount = useCallback(
    (editor: any, monaco: any) => {
      editorRef.current = editor;

      // Always connect editor to the hook (needed for AI modifications)
      setEditor(editor);

      // CMD/CTRL + Enter execution support
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        // Use handleExecute which already has diff mode logic
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
        setHasUnsavedChanges(hasChanges);

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
    [
      enableVersionControl,
      setEditor,
      handleExecute,
      handleSave,
      onSave,
      dbContentHash,
      saveUserEdit,
    ],
  );

  // Debounced content change notification for persistence (zustand + localStorage)
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const content = value || "";

      // Always check if content has changed from DB version (even for undo/redo)
      const currentContentHash = hashContent(content);
      const hasChanges = !dbContentHash || currentContentHash !== dbContentHash;
      setHasUnsavedChanges(hasChanges);

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
    },
    [
      onContentChange,
      enableVersionControl,
      saveUserEdit,
      isApplyingModification,
      dbContentHash,
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
      const currentContent = getCurrentEditorContent();
      const newContent = calculateModifiedContent(currentContent, modification);

      setOriginalContent(currentContent);
      setModifiedContent(newContent);
      setPendingModification(modification);
      setIsDiffMode(true);
    },
    [getCurrentEditorContent, calculateModifiedContent],
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
            setHasUnsavedChanges(hasChanges);
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

  useImperativeHandle(
    ref,
    () => ({
      getCurrentContent: () => {
        const content = getCurrentEditorContent();
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
    }),
    [
      getCurrentEditorContent,
      title,
      applyModification,
      undo,
      redo,
      canUndo,
      canRedo,
      showDiff,
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
          <Button
            variant="contained"
            size="small"
            startIcon={<PlayIcon />}
            onClick={handleExecute}
            disabled={isExecuting || !selectedDatabaseId}
            disableElevation
            sx={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "200px", // Adjust this value as needed
              minWidth: "120px", // Ensure minimum width for readability
            }}
          >
            {isExecuting ? "Executing..." : "Run (⌘/Ctrl+Enter)"}
          </Button>

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
              value={selectedDatabaseId}
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
                  value={selectedSubDbId || ""}
                  onChange={(e) => {
                    const dbId = e.target.value || undefined;
                    const db = availableDatabases.find(d => d.id === dbId);
                    setSelectedSubDbId(dbId);
                    setSelectedSubDbName(db?.label);
                  }}
                  disabled={isLoadingDatabases || availableDatabases.length === 0}
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
