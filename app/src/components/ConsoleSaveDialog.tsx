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

interface BreadcrumbItem {
  id: string | null;
  name: string;
  section: "my" | "workspace";
}

interface ConsoleSaveDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (
    name: string,
    folderId: string | null,
    section: "my" | "workspace",
  ) => void;
  defaultName?: string;
  isSaving?: boolean;
}

export default function ConsoleSaveDialog({
  open,
  onClose,
  onSave,
  defaultName = "",
  isSaving = false,
}: ConsoleSaveDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const workspaceConsoles = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];

  const [consoleName, setConsoleName] = useState(defaultName);
  const [currentSection, setCurrentSection] = useState<"my" | "workspace">(
    "my",
  );
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { id: null, name: "My Consoles", section: "my" },
  ]);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const createFolder = useConsoleTreeStore(state => state.createFolder);

  useEffect(() => {
    if (open) {
      setConsoleName(defaultName);
      setCurrentSection("my");
      setBreadcrumb([{ id: null, name: "My Consoles", section: "my" }]);
      setNewFolderMode(false);
      setNewFolderName("");
    }
  }, [open, defaultName]);

  const getCurrentFolders = useCallback((): ConsoleEntry[] => {
    const rootNodes = currentSection === "my" ? myConsoles : workspaceConsoles;
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
  }, [currentSection, myConsoles, workspaceConsoles, breadcrumb]);

  const handleFolderClick = (folder: ConsoleEntry) => {
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

  const handleSave = () => {
    if (!consoleName.trim()) return;
    const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id;
    onSave(consoleName.trim(), currentFolderId, currentSection);
  };

  const handleCreateFolder = async () => {
    if (!currentWorkspace || !newFolderName.trim()) return;
    const parentId = breadcrumb[breadcrumb.length - 1]?.id;
    const result = await createFolder(
      currentWorkspace.id,
      newFolderName.trim(),
      parentId,
    );
    if (result) {
      setNewFolderMode(false);
      setNewFolderName("");
    }
  };

  const folders = getCurrentFolders();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { minHeight: 420 } }}
    >
      <DialogTitle sx={{ pb: 1 }}>Save Console</DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
          pt: "8px !important",
        }}
      >
        <TextField
          autoFocus
          label="Console Name"
          fullWidth
          variant="outlined"
          size="small"
          value={consoleName}
          onChange={e => setConsoleName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && consoleName.trim()) {
              handleSave();
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />

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
          Save Location
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
            minHeight: 120,
            maxHeight: 200,
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
                No subfolders. Save here or create one.
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

        {/* New folder inline */}
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
          onClick={handleSave}
          disabled={!consoleName.trim() || isSaving}
          variant="contained"
          disableElevation
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
