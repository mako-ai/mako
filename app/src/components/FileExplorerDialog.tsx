import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
  Breadcrumbs,
  Link,
  Divider,
} from "@mui/material";
import {
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  ChevronRight as ChevronRightIcon,
  SquareTerminal as ConsoleIcon,
  Globe as GlobeIcon,
} from "lucide-react";
import { CreateNewFolder as CreateFolderIcon } from "@mui/icons-material";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
} from "../store/consoleTreeStore";
import { useWorkspace } from "../contexts/workspace-context";

type DialogMode = "save" | "move" | "new-folder";

interface BreadcrumbItem {
  id: string | null;
  name: string;
  section: "my" | "workspace";
}

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

  /** move mode: called with target folderId (null = root) */
  onMove?: (targetFolderId: string | null) => void;
  itemName?: string;
  isDirectory?: boolean;

  /** new-folder mode: called with parent folderId (null = root) */
  onNewFolder?: (parentFolderId: string | null) => void;
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
}: FileExplorerDialogProps) {
  const { currentWorkspace } = useWorkspace();

  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );
  const createFolderAction = useConsoleTreeStore(state => state.createFolder);

  const myConsolesTree = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const workspaceConsoles = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];

  const [consoleName, setConsoleName] = useState(defaultName);
  const [folderName, setFolderName] = useState("");
  const [currentSection, setCurrentSection] = useState<"my" | "workspace">(
    "my",
  );
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { id: null, name: "My Consoles", section: "my" },
  ]);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (open) {
      setConsoleName(defaultName);
      setFolderName("");
      setCurrentSection("my");
      setBreadcrumb([{ id: null, name: "My Consoles", section: "my" }]);
      setNewFolderMode(false);
      setNewFolderName("");
    }
  }, [open, defaultName]);

  const getCurrentFolders = useCallback((): ConsoleEntry[] => {
    const rootNodes =
      currentSection === "my" ? myConsolesTree : workspaceConsoles;
    const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id;

    if (!currentFolderId) {
      return rootNodes.filter(n => n.isDirectory);
    }

    const findFolder = (
      nodes: ConsoleEntry[],
      targetId: string,
    ): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === targetId && node.isDirectory) return node;
        if (node.isDirectory && node.children) {
          const found = findFolder(node.children, targetId);
          if (found) return found;
        }
      }
      return null;
    };

    const folder = findFolder(rootNodes, currentFolderId);
    return folder?.children?.filter(n => n.isDirectory) || [];
  }, [currentSection, myConsolesTree, workspaceConsoles, breadcrumb]);

  const handleFolderClick = (folder: ConsoleEntry) => {
    if (!folder.id) return;
    setBreadcrumb(prev => [
      ...prev,
      { id: folder.id!, name: folder.name, section: currentSection },
    ]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumb(prev => prev.slice(0, index + 1));
    setCurrentSection(breadcrumb[index].section);
  };

  const handleSectionSwitch = (section: "my" | "workspace") => {
    setCurrentSection(section);
    setBreadcrumb([
      {
        id: null,
        name: section === "my" ? "My Consoles" : "Workspace",
        section,
      },
    ]);
  };

  const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id ?? null;

  const handleConfirm = () => {
    if (mode === "save") {
      if (!consoleName.trim()) return;
      onSave?.(consoleName.trim(), currentFolderId, currentSection);
    } else if (mode === "move") {
      onMove?.(currentFolderId);
    } else if (mode === "new-folder") {
      if (!folderName.trim()) return;
      onNewFolder?.(currentFolderId);
    }
  };

  const handleCreateFolder = async () => {
    if (!currentWorkspace || !newFolderName.trim()) return;
    const result = await createFolderAction(
      currentWorkspace.id,
      newFolderName.trim(),
      currentFolderId,
    );
    if (result) {
      setNewFolderMode(false);
      setNewFolderName("");
    }
  };

  const folders = getCurrentFolders();

  const dialogTitle =
    mode === "save"
      ? "Save Console"
      : mode === "move"
        ? `Move "${itemName}"`
        : "Create New Folder";

  const confirmLabel =
    mode === "save"
      ? isSaving
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
      <DialogTitle sx={{ pb: 1 }}>{dialogTitle}</DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
          pt: "8px !important",
        }}
      >
        {/* Name input — save mode gets console name, new-folder mode gets folder name */}
        {mode === "save" && (
          <TextField
            autoFocus
            label="Console Name"
            fullWidth
            variant="outlined"
            size="small"
            value={consoleName}
            onChange={e => setConsoleName(e.target.value)}
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

        <Divider />

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {mode === "save"
            ? "Save Location"
            : mode === "move"
              ? "Destination"
              : "Location"}
        </Typography>

        {/* Section tabs */}
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            size="small"
            variant={currentSection === "my" ? "contained" : "outlined"}
            disableElevation
            onClick={() => handleSectionSwitch("my")}
            startIcon={<ConsoleIcon size={16} />}
            sx={{ textTransform: "none", fontSize: "0.8rem" }}
          >
            My Consoles
          </Button>
          <Button
            size="small"
            variant={currentSection === "workspace" ? "contained" : "outlined"}
            disableElevation
            onClick={() => handleSectionSwitch("workspace")}
            startIcon={<GlobeIcon size={16} />}
            sx={{ textTransform: "none", fontSize: "0.8rem" }}
          >
            Workspace
          </Button>
        </Box>

        {/* Breadcrumb */}
        <Breadcrumbs
          separator={<ChevronRightIcon size={14} />}
          sx={{ fontSize: "0.85rem" }}
        >
          {breadcrumb.map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            return isLast ? (
              <Typography
                key={index}
                variant="body2"
                fontWeight={600}
                fontSize="0.85rem"
              >
                {item.name}
              </Typography>
            ) : (
              <Link
                key={index}
                component="button"
                variant="body2"
                underline="hover"
                onClick={() => handleBreadcrumbClick(index)}
                sx={{ fontSize: "0.85rem", cursor: "pointer" }}
              >
                {item.name}
              </Link>
            );
          })}
        </Breadcrumbs>

        {/* Folder list */}
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            minHeight: 140,
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {folders.length === 0 && !newFolderMode ? (
            <Box sx={{ p: 2, textAlign: "center" }}>
              <Typography
                variant="body2"
                color="text.disabled"
                fontStyle="italic"
              >
                {mode === "save"
                  ? "No subfolders. Save here or create one."
                  : mode === "move"
                    ? "No subfolders. Move here or create one."
                    : "No subfolders. Create the folder here."}
              </Typography>
            </Box>
          ) : (
            <List dense disablePadding>
              {folders.map(folder => (
                <ListItemButton
                  key={folder.id || folder.path}
                  onClick={() => handleFolderClick(folder)}
                  sx={{ py: 0.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <FolderIcon size={18} strokeWidth={1.5} />
                  </ListItemIcon>
                  <ListItemText
                    primary={folder.name}
                    primaryTypographyProps={{ variant: "body2" }}
                  />
                  <ChevronRightIcon size={16} style={{ opacity: 0.4 }} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>

        {/* Inline new folder creation */}
        {newFolderMode ? (
          <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <FolderOpenIcon size={18} strokeWidth={1.5} />
            <TextField
              autoFocus
              size="small"
              placeholder="Folder name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newFolderName.trim()) {
                  handleCreateFolder();
                }
                if (e.key === "Escape") {
                  setNewFolderMode(false);
                  setNewFolderName("");
                }
              }}
              sx={{ flex: 1 }}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              size="small"
              variant="outlined"
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim()}
            >
              Create
            </Button>
            <Button
              size="small"
              onClick={() => {
                setNewFolderMode(false);
                setNewFolderName("");
              }}
            >
              Cancel
            </Button>
          </Box>
        ) : (
          <Button
            size="small"
            startIcon={<CreateFolderIcon fontSize="small" />}
            onClick={() => setNewFolderMode(true)}
            sx={{ alignSelf: "flex-start", textTransform: "none" }}
          >
            New Folder
          </Button>
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
