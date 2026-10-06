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
import {
  consoleNameProblem,
  consoleNameTakenBy,
  consoleNameTakenMessage,
} from "../lib/console-relocation";

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

  /** Dialog title (defaults per mode). */
  title?: string;
  /** Confirm button label (defaults per mode). */
  confirmLabel?: string;
  /**
   * The item being moved/renamed: excluded from the "name already taken
   * here" check (a rename in place is not a clash with itself).
   */
  selfId?: string;
  /**
   * The item's place cannot change (a console shared with this person):
   * the folder picker is replaced by its location and this reason; only
   * the name can be edited.
   */
  locationLockedReason?: string | null;
  /** Where the item is, shown when its location is locked. */
  locationLabel?: string;
  /**
   * Only folders of this section may be picked (changing who sees a
   * console is its owner's or an admin's call); the reason is shown.
   */
  lockedSection?: "my" | "workspace" | null;
  sectionLockedReason?: string | null;
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
  title,
  confirmLabel: confirmLabelOverride,
  selfId,
  locationLockedReason,
  locationLabel,
  lockedSection,
  sectionLockedReason,
}: FileExplorerDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const myConsolesMap = useConsoleTreeStore(state => state.myItems);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.workspaceItems,
  );

  const [consoleName, setConsoleName] = useState(defaultName);
  const [folderName, setFolderName] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<"my" | "workspace">(
    "my",
  );
  // A click in a section this person may not move the item into: the
  // selection stays, the reason is said (once per click).
  const [sectionNotice, setSectionNotice] = useState(false);

  const treeRef = useRef<ConsoleTreeRef | null>(null);

  const effectiveName = mode === "move" ? itemName : defaultName;

  useEffect(() => {
    if (open) {
      setConsoleName(effectiveName);
      setFolderName("");
      setSelectedFolderId(initialFolderId ?? null);
      setSelectedSection(initialSection ?? "my");
      setSectionNotice(false);
    }
  }, [open, effectiveName, initialFolderId, initialSection]);

  const handleLocationChange = (
    folderId: string | null,
    section: "my" | "workspace",
  ) => {
    if (lockedSection && section !== lockedSection) {
      setSectionNotice(true);
      return;
    }
    setSectionNotice(false);
    setSelectedFolderId(folderId);
    setSelectedSection(section);
  };

  const findExistingConsole = useCallback(
    (name: string, folderId: string | null): ConsoleEntry | null => {
      if (!currentWorkspace) return null;
      return consoleNameTakenBy(
        {
          my: myConsolesMap[currentWorkspace.id] || [],
          workspace: sharedWithWorkspaceMap[currentWorkspace.id] || [],
        },
        selectedSection,
        folderId,
        name,
        selfId,
      );
    },
    [
      currentWorkspace,
      myConsolesMap,
      sharedWithWorkspaceMap,
      selectedSection,
      selfId,
    ],
  );

  const showNameField = mode === "save" || (mode === "move" && !isDirectory);
  const trimmedName = consoleName.trim();
  // Why the typed name cannot be used: a "/" (the folder has its own
  // picker), or a console of that name already in the chosen folder. A
  // clash is REFUSED — there is no "Replace": overwriting another console
  // by renaming onto it destroyed it, and the server refuses it anyway.
  // A locked location may be a folder this person cannot see (the
  // owner's): the tree cannot judge a clash there — the server does.
  const clash =
    showNameField && trimmedName && !locationLockedReason
      ? findExistingConsole(trimmedName, selectedFolderId)
      : null;
  const nameProblem = !showNameField
    ? null
    : mode === "move" && !trimmedName
      ? null
      : (consoleNameProblem(consoleName) ??
        (clash ? consoleNameTakenMessage(trimmedName, clash.name) : null));

  const handleConfirm = () => {
    if (mode === "save") {
      if (!trimmedName || nameProblem) return;
      onSave?.(trimmedName, selectedFolderId, selectedSection);
    } else if (mode === "move") {
      if (nameProblem) return;
      const nameChanged = trimmedName && trimmedName !== itemName;
      onMove?.(
        selectedFolderId,
        nameChanged ? trimmedName : undefined,
        selectedSection,
      );
    } else if (mode === "new-folder") {
      if (!folderName.trim()) return;
      onNewFolder?.(selectedFolderId, folderName.trim());
    }
  };

  const handleNewFolder = () => {
    const access = selectedSection === "workspace" ? "workspace" : "private";
    treeRef.current?.createFolder(selectedFolderId, access);
  };

  const handleFileClick = (node: ConsoleEntry) => {
    // Save: picking a console offers its name. Rename / Move: a click in
    // the tree is never a new name — a misclick on another console renamed
    // the one being moved to that console's name.
    if (mode === "save") setConsoleName(node.name);
  };

  const handleNameChange = (value: string) => {
    setConsoleName(value);
  };

  const dialogTitle =
    title ??
    (mode === "save"
      ? "Save Console"
      : mode === "move"
        ? `Move "${itemName}"`
        : "Create New Folder");

  const confirmLabel =
    confirmLabelOverride ??
    (mode === "save"
      ? isSaving
        ? "Saving..."
        : "Save"
      : mode === "move"
        ? "Move Here"
        : "Create Here");

  const confirmDisabled =
    mode === "save"
      ? !trimmedName || !!nameProblem || isSaving
      : mode === "new-folder"
        ? !folderName.trim()
        : !!nameProblem;

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
        {!locationLockedReason && (
          <Tooltip title="New Folder">
            <IconButton size="small" onClick={handleNewFolder}>
              <CreateFolderIcon size={18} strokeWidth={1.5} />
            </IconButton>
          </Tooltip>
        )}
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
              if (e.key === "Enter" && trimmedName && !confirmDisabled) {
                handleConfirm();
              }
            }}
            error={!!nameProblem}
            helperText={nameProblem ?? undefined}
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

        {locationLockedReason ? (
          <Box sx={{ py: 1 }}>
            {locationLabel && (
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                Location: {locationLabel}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {locationLockedReason}
            </Typography>
          </Box>
        ) : (
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
              initialSection={initialSection}
            />
          </Box>
        )}

        {!locationLockedReason && sectionLockedReason && (
          <Typography
            variant="caption"
            color={sectionNotice ? "warning.main" : "text.secondary"}
            sx={{ mt: 0.5 }}
          >
            {sectionLockedReason}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleConfirm}
          disabled={confirmDisabled}
          variant="contained"
          disableElevation
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
