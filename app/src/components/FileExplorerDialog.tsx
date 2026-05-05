import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import { FolderPlus as CreateFolderIcon } from "lucide-react";
import ConsoleTree, { type ConsoleTreeRef } from "./ConsoleTree";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
} from "../store/consoleTreeStore";
import { useWorkspace } from "../contexts/workspace-context";

type DialogMode = "save" | "move" | "new-folder";

interface FileExplorerDialogProps {
  open: boolean;
  onClose: () => void;
  mode: DialogMode;

  /** save mode: called with (name, folderId, section) */
  onSave?: (
    name: string,
    folderId: string | null,
    section: "my" | "workspace",
  ) => void;
  defaultName?: string;
  isSaving?: boolean;

  /** move mode: called with (targetFolderId, newName, section) */
  onMove?: (
    targetFolderId: string | null,
    newName?: string,
    section?: "my" | "workspace",
  ) => void;
  itemName?: string;
  isDirectory?: boolean;

  /** new-folder mode: called with parent folderId (null = root) */
  onNewFolder?: (parentFolderId: string | null, name: string) => void;

  /** Pre-select this folder on open (e.g. the item's current parent) */
  initialFolderId?: string | null;
  initialSection?: "my" | "workspace";
}

export default function FileExplorerDialog({
  open,
  onClose,
  mode,
  onSave,
  defaultName = "",
  isSaving = false,
  onMove,
  itemName = "",
  onNewFolder,
  initialFolderId,
  initialSection,
  isDirectory = false,
}: FileExplorerDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );

  const [consoleName, setConsoleName] = useState(defaultName);
  const [folderName, setFolderName] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<"my" | "workspace">(
    "my",
  );
  const [overwriteConfirm, setOverwriteConfirm] = useState(false);

  const treeRef = useRef<ConsoleTreeRef | null>(null);

  const effectiveName = mode === "move" ? itemName : defaultName;

  useEffect(() => {
    if (open) {
      setConsoleName(effectiveName);
      setFolderName("");
      setSelectedFolderId(initialFolderId ?? null);
      setSelectedSection(initialSection ?? "my");
      setOverwriteConfirm(false);
    }
  }, [open, effectiveName, initialFolderId, initialSection]);

  const handleLocationChange = (
    folderId: string | null,
    section: "my" | "workspace",
  ) => {
    setSelectedFolderId(folderId);
    setSelectedSection(section);
  };

  const findExistingConsole = useCallback(
    (name: string, folderId: string | null): ConsoleEntry | null => {
      if (!currentWorkspace) return null;
      const myConsoles = myConsolesMap[currentWorkspace.id] || [];
      const workspaceConsoles =
        sharedWithWorkspaceMap[currentWorkspace.id] || [];

      const searchInFolder = (
        nodes: ConsoleEntry[],
        targetFolderId: string | null,
      ): ConsoleEntry | null => {
        if (!targetFolderId) {
          return (
            nodes.find(
              n =>
                !n.isDirectory && n.name.toLowerCase() === name.toLowerCase(),
            ) ?? null
          );
        }
        for (const node of nodes) {
          if (node.id === targetFolderId && node.isDirectory && node.children) {
            return (
              node.children.find(
                n =>
                  !n.isDirectory && n.name.toLowerCase() === name.toLowerCase(),
              ) ?? null
            );
          }
          if (node.isDirectory && node.children) {
            const found = searchInFolder(node.children, targetFolderId);
            if (found) return found;
          }
        }
        return null;
      };

      return (
        searchInFolder(myConsoles, folderId) ??
        searchInFolder(workspaceConsoles, folderId)
      );
    },
    [currentWorkspace, myConsolesMap, sharedWithWorkspaceMap],
  );

  const handleConfirm = () => {
    if (mode === "save") {
      if (!consoleName.trim()) return;
      const existing = findExistingConsole(
        consoleName.trim(),
        selectedFolderId,
      );
      if (existing && !overwriteConfirm) {
        setOverwriteConfirm(true);
        return;
      }
      setOverwriteConfirm(false);
      onSave?.(consoleName.trim(), selectedFolderId, selectedSection);
    } else if (mode === "move") {
      const newName = consoleName.trim();
      const nameChanged = newName && newName !== itemName;
      onMove?.(
        selectedFolderId,
        nameChanged ? newName : undefined,
        selectedSection,
      );
    } else if (mode === "new-folder") {
      if (!folderName.trim()) return;
      onNewFolder?.(selectedFolderId, folderName.trim());
    }
  };

  const handleCancelOverwrite = () => {
    setOverwriteConfirm(false);
  };

  const handleNewFolder = () => {
    const access = selectedSection === "workspace" ? "workspace" : "private";
    treeRef.current?.createFolder(selectedFolderId, access);
  };

  const handleFileClick = (node: ConsoleEntry) => {
    if (mode === "save" || mode === "move") {
      setConsoleName(node.name);
    }
  };

  const handleNameChange = (value: string) => {
    setConsoleName(value);
    if (overwriteConfirm) setOverwriteConfirm(false);
  };

  const showNameField = mode === "save" || (mode === "move" && !isDirectory);

  const dialogTitle =
    mode === "save"
      ? "Save Console"
      : mode === "move"
        ? `Move "${itemName}"`
        : "Create New Folder";

  const confirmLabel =
    mode === "save"
      ? overwriteConfirm
        ? "Replace"
        : isSaving
          ? "Saving..."
          : "Save"
      : mode === "move"
        ? "Move Here"
        : "Create Here";

  const confirmDisabled =
    mode === "save"
      ? !consoleName.trim() || isSaving
      : mode === "new-folder"
        ? !folderName.trim()
        : false;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { minHeight: 460 } }}
    >
      <DialogTitle
        sx={{ pb: 0, pt: 1.5, px: 2, display: "flex", alignItems: "center" }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }} className="app-truncate">
          {dialogTitle}
        </Box>
        <Tooltip title="New Folder">
          <IconButton size="small" onClick={handleNewFolder}>
            <CreateFolderIcon size={18} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 0.75,
          pt: "4px !important",
          px: 2,
          pb: 1,
          overflow: "hidden",
        }}
      >
        {showNameField && (
          <TextField
            autoFocus
            label={mode === "move" ? "Name" : "Console Name"}
            fullWidth
            variant="outlined"
            size="small"
            value={consoleName}
            onChange={e => handleNameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && consoleName.trim()) handleConfirm();
            }}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {mode === "new-folder" && (
          <TextField
            autoFocus
            label="Folder Name"
            fullWidth
            variant="outlined"
            size="small"
            value={folderName}
            onChange={e => setFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && folderName.trim()) handleConfirm();
            }}
            autoComplete="off"
            spellCheck={false}
          />
        )}

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <ConsoleTree
            ref={treeRef}
            mode="picker"
            showFiles
            enableDragDrop
            enableRename
            enableDelete
            enableDuplicate={false}
            enableInfo={false}
            enableMove={false}
            onLocationChange={handleLocationChange}
            onFileClick={handleFileClick}
            selectedLocationId={selectedFolderId}
            selectedSectionKey={selectedSection}
            initialFolderId={initialFolderId}
          />
        </Box>

        {overwriteConfirm && (
          <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
            A console named &ldquo;{consoleName.trim()}&rdquo; already exists
            here. Click Replace to overwrite it.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        {overwriteConfirm && (
          <Button onClick={handleCancelOverwrite}>Back</Button>
        )}
        <Button
          onClick={handleConfirm}
          disabled={confirmDisabled}
          variant="contained"
          disableElevation
          color={overwriteConfirm ? "warning" : "primary"}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
