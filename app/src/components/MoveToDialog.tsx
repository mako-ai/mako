import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Box,
  Breadcrumbs,
  Link,
  TextField,
} from "@mui/material";
import {
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  ChevronRight as ChevronRightIcon,
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
}

interface MoveToDialogProps {
  open: boolean;
  onClose: () => void;
  onMove: (targetFolderId: string | null) => void;
  itemName: string;
  isDirectory: boolean;
}

export default function MoveToDialog({
  open,
  onClose,
  onMove,
  itemName,
  isDirectory,
}: MoveToDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const createFolder = useConsoleTreeStore(state => state.createFolder);

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];

  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { id: null, name: "My Consoles" },
  ]);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (open) {
      setBreadcrumb([{ id: null, name: "My Consoles" }]);
      setNewFolderMode(false);
      setNewFolderName("");
    }
  }, [open]);

  const getCurrentFolders = useCallback((): ConsoleEntry[] => {
    const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id;

    if (!currentFolderId) {
      return myConsoles.filter(n => n.isDirectory);
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

    const folder = findFolder(myConsoles, currentFolderId);
    return folder?.children?.filter(n => n.isDirectory) || [];
  }, [myConsoles, breadcrumb]);

  const handleFolderClick = (folder: ConsoleEntry) => {
    setBreadcrumb(prev => [...prev, { id: folder.id!, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumb(prev => prev.slice(0, index + 1));
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

  const handleMove = () => {
    const currentFolderId = breadcrumb[breadcrumb.length - 1]?.id;
    onMove(currentFolderId);
  };

  const folders = getCurrentFolders();

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Move &ldquo;{itemName}&rdquo;</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}
      >
        <Typography variant="body2" color="text.secondary">
          Select a destination folder for this{" "}
          {isDirectory ? "folder" : "console"}.
        </Typography>

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

        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            minHeight: 120,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {folders.length === 0 ? (
            <Box sx={{ p: 2, textAlign: "center" }}>
              <Typography
                variant="body2"
                color="text.disabled"
                fontStyle="italic"
              >
                No subfolders here.
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
        <Button onClick={handleMove} variant="contained" disableElevation>
          Move Here
        </Button>
      </DialogActions>
    </Dialog>
  );
}
