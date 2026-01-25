import { useEffect, useState, forwardRef, useImperativeHandle } from "react";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  IconButton,
  Skeleton,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Tooltip,
  Alert,
} from "@mui/material";
import {
  CreateNewFolder as CreateFolderIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from "@mui/icons-material";
import {
  SquareTerminal as ConsoleIcon,
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  RotateCw as RefreshIcon,
  Plus as AddIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
} from "lucide-react";
import { useExplorerStore } from "../store/explorerStore";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleTreeStore } from "../store/consoleTreeStore";
import { useConsoleContentStore } from "../store/consoleContentStore";

interface ConsoleEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ConsoleEntry[];
  content?: string; // Added to match potential server object, though not used in rendering tree directly
  id?: string; // Database ID for saved consoles/folders
  folderId?: string; // Database ID for folders
  connectionId?: string; // Associated connection ID (DatabaseConnection ObjectId)
  databaseId?: string; // Associated database ID
  databaseName?: string; // Associated database name
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
}

interface ConsoleExplorerProps {
  onConsoleSelect: (
    path: string,
    content: string,
    connectionId?: string,
    consoleId?: string, // Add consoleId parameter
    isPlaceholder?: boolean,
    databaseId?: string,
    databaseName?: string,
  ) => void;
}

export interface ConsoleExplorerRef {
  refresh: () => void;
}

function ConsoleExplorer(
  props: ConsoleExplorerProps,
  ref: React.Ref<ConsoleExplorerRef>,
) {
  const { onConsoleSelect } = props;
  const { currentWorkspace } = useWorkspace();
  const trees = useConsoleTreeStore(state => state.trees);
  const loadingMap = useConsoleTreeStore(state => state.loading);
  const refreshTree = useConsoleTreeStore(state => state.refresh);

  const consoleEntries = currentWorkspace
    ? trees[currentWorkspace.id] || []
    : [];
  const loading = currentWorkspace ? !!loadingMap[currentWorkspace.id] : false;
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const expandedFolders = useExplorerStore(
    state => state.console.expandedFolders,
  );
  const toggleFolder = useExplorerStore(state => state.toggleFolder);
  const error = currentWorkspace ? _errorFor(currentWorkspace.id) : null;
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedParentFolder, setSelectedParentFolder] = useState<
    string | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: ConsoleEntry;
  } | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ConsoleEntry | null>(null);
  const [newItemName, setNewItemName] = useState("");

  function _errorFor(wid: string) {
    const map = useConsoleTreeStore.getState().error;
    return map[wid] || null;
  }

  const fetchConsoleEntries = async () => {
    if (!currentWorkspace) return;
    await refreshTree(currentWorkspace.id);
  };

  // Console tree is preloaded in workspace-context.tsx when workspace changes
  // No need to call init here - the tree is already loaded

  useImperativeHandle(ref, () => ({
    refresh: () => {
      fetchConsoleEntries();
    },
  }));

  const handleFolderToggle = (folderPath: string) => {
    toggleFolder(folderPath);
  };

  const handleFileClick = async (node: ConsoleEntry) => {
    if (!currentWorkspace) {
      console.error("No workspace selected");
      return;
    }

    if (!node.id) {
      console.error("Console has no ID, cannot open");
      return;
    }

    // 1) Optimistically select the item and open/focus tab immediately
    const consoleId = node.id;
    const cached = useConsoleContentStore.getState().get(consoleId);
    const initialContent = cached?.content ?? "loading...";
    const connectionId = cached?.connectionId || node.connectionId;
    const databaseId = cached?.databaseId || node.databaseId;
    const databaseName = cached?.databaseName || node.databaseName;
    onConsoleSelect(
      node.path,
      initialContent,
      connectionId,
      consoleId,
      !cached,
      databaseId,
      databaseName,
    );

    // 2) Fetch in background via store and update cache
    try {
      const consoleStore = await import("../store/consoleStore");
      const { fetchConsoleContent } = consoleStore.useConsoleStore.getState();
      const data = await fetchConsoleContent(currentWorkspace.id, consoleId);
      if (data) {
        useConsoleContentStore.getState().set(consoleId, {
          content: data.content,
          connectionId: data.connectionId || node.connectionId,
          databaseId: data.databaseId || node.databaseId,
          databaseName: data.databaseName || node.databaseName,
        });
        // Optionally update tab content if it is still open and was showing stale/placeholder
        const {
          updateContent,
          updateFilePath,
          updateDatabase,
          updateConnection,
          updateSavedState,
        } = consoleStore.useConsoleStore.getState();
        updateContent(consoleId, data.content);

        // Update the connection and database info
        if (data.connectionId) {
          updateConnection(consoleId, data.connectionId);
        }
        if (data.databaseId || data.databaseName) {
          updateDatabase(consoleId, data.databaseId, data.databaseName);
        }

        // Update the file path so the editor knows this is an existing file
        // This fixes the "Save As" prompt appearing for existing consoles
        updateFilePath(consoleId, node.path);

        // Mark as saved (isSaved=true) since this is an existing console from the database
        // This fixes auto-save incorrectly triggering for saved consoles opened with placeholder content
        const { computeConsoleStateHash } = await import("../utils/stateHash");
        const savedStateHash = computeConsoleStateHash(
          data.content,
          data.connectionId,
          data.databaseId,
          data.databaseName,
        );
        updateSavedState(consoleId, true, savedStateHash);
      }
    } catch (e) {
      // Background error shouldn't block UI
      console.error("Background fetch failed", e);
    }
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setMenuAnchor(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleCreateFolder = () => {
    setFolderDialogOpen(true);
    setSelectedParentFolder(null);
    handleMenuClose();
  };

  const handleCreateFolderInParent = (parentFolderId: string) => {
    setFolderDialogOpen(true);
    setSelectedParentFolder(parentFolderId);
  };

  const handleFolderDialogClose = () => {
    setFolderDialogOpen(false);
    setNewFolderName("");
    setSelectedParentFolder(null);
  };

  const handleFolderCreate = async () => {
    if (!currentWorkspace || !newFolderName.trim()) {
      return;
    }

    try {
      const response = await fetch(
        `/api/workspaces/${currentWorkspace.id}/consoles/folders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: newFolderName.trim(),
            parentId: selectedParentFolder || undefined,
            isPrivate: false,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        handleFolderDialogClose();
        fetchConsoleEntries(); // Refresh the tree
      } else {
        console.error("Failed to create folder:", data.error);
      }
    } catch (e: any) {
      console.error("Failed to create folder:", e);
    }
  };

  const handleContextMenu = (event: React.MouseEvent, item: ConsoleEntry) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
      item,
    });
  };

  const handleContextMenuClose = () => {
    setContextMenu(null);
  };

  const handleRename = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setNewItemName(item.name);
    setRenameDialogOpen(true);
    handleContextMenuClose();
  };

  const handleDelete = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
    handleContextMenuClose();
  };

  const handleRenameConfirm = async () => {
    if (!currentWorkspace || !selectedItem || !newItemName.trim()) {
      return;
    }

    try {
      const endpoint = selectedItem.isDirectory
        ? `/api/workspaces/${currentWorkspace.id}/consoles/folders/${selectedItem.id}/rename`
        : `/api/workspaces/${currentWorkspace.id}/consoles/${selectedItem.id}/rename`;

      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: newItemName.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setRenameDialogOpen(false);
        setSelectedItem(null);
        setNewItemName("");
        fetchConsoleEntries(); // Refresh the tree
      } else {
        console.error("Failed to rename item:", data.error);
      }
    } catch (e: any) {
      console.error("Failed to rename item:", e);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem) {
      return;
    }

    try {
      const endpoint = selectedItem.isDirectory
        ? `/api/workspaces/${currentWorkspace.id}/consoles/folders/${selectedItem.id}`
        : `/api/workspaces/${currentWorkspace.id}/consoles/${selectedItem.id}`;

      const response = await fetch(endpoint, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setDeleteDialogOpen(false);
        setSelectedItem(null);
        fetchConsoleEntries(); // Refresh the tree
      } else {
        console.error("Failed to delete item:", data.error);
      }
    } catch (e: any) {
      console.error("Failed to delete item:", e);
    }
  };

  const renderTree = (nodes: ConsoleEntry[], depth = 0) => {
    return nodes.map(node => {
      if (node.isDirectory) {
        const isExpanded = expandedFolders.has(node.path);
        // Use ID if available, otherwise fall back to path for key
        const nodeKey = node.id || node.path;
        return (
          <div key={`dir-${nodeKey}`}>
            <ListItemButton
              onClick={() => handleFolderToggle(node.path)}
              onContextMenu={e => handleContextMenu(e, node)}
              sx={{ py: 0.25, pl: 0.5 + depth * 1.5 }}
            >
              <ListItemIcon sx={{ minWidth: 22, mr: 0 }}>
                {isExpanded ? (
                  <ChevronDownIcon strokeWidth={1.5} size={20} />
                ) : (
                  <ChevronRightIcon strokeWidth={1.5} size={20} />
                )}
              </ListItemIcon>
              <ListItemIcon sx={{ minWidth: 24 }}>
                {isExpanded ? (
                  <FolderOpenIcon strokeWidth={1.5} size={18} />
                ) : (
                  <FolderIcon strokeWidth={1.5} size={18} />
                )}
              </ListItemIcon>
              <ListItemText
                primary={node.name}
                primaryTypographyProps={{
                  variant: "body2",
                  style: {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              />
            </ListItemButton>
            {isExpanded && (
              <List component="div" disablePadding dense>
                {node.children && renderTree(node.children, depth + 1)}
              </List>
            )}
          </div>
        );
      }
      // Use ID if available, otherwise fall back to path for key
      const nodeKey = node.id || node.path;
      const isActive = !!(node.id && activeTabId === node.id);
      return (
        <ListItemButton
          key={`file-${nodeKey}`}
          onClick={() => handleFileClick(node)}
          onContextMenu={e => handleContextMenu(e, node)}
          selected={isActive}
          sx={{
            py: 0.25,
            pl: 0.5 + depth * 1.5,
          }}
        >
          <ListItemIcon sx={{ minWidth: 22, visibility: "hidden", mr: 0 }} />
          <ListItemIcon sx={{ minWidth: 24 }}>
            <ConsoleIcon size={18} strokeWidth={1.5} />
          </ListItemIcon>
          <ListItemText
            primary={node.name}
            primaryTypographyProps={{
              variant: "body2",
              fontSize: "0.9rem",
              style: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            }}
          />
        </ListItemButton>
      );
    });
  };

  const renderSkeletonItems = () => {
    return Array.from({ length: 3 }).map((_, index) => (
      <ListItemButton key={`skeleton-${index}`} sx={{ py: 0.25, pl: 0.5 }}>
        <ListItemIcon sx={{ minWidth: 22, visibility: "hidden", mr: 0 }} />
        <ListItemIcon sx={{ minWidth: 24 }}>
          <Skeleton variant="circular" width={18} height={18} />
        </ListItemIcon>
        <ListItemText
          primary={
            <Skeleton
              variant="text"
              width={`${60 + Math.random() * 40}%`}
              height={20}
            />
          }
        />
      </ListItemButton>
    ));
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Box
            sx={{
              flexGrow: 1,
              overflow: "hidden",
              maxWidth: "calc(100% - 80px)",
            }}
          >
            <Typography
              variant="h6"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}
            >
              Consoles
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="Add new folder">
              <IconButton onClick={handleMenuOpen} size="small">
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton onClick={fetchConsoleEntries} size="small">
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>
      {error && (
        <Box sx={{ p: 2 }}>
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        </Box>
      )}
      <List
        component="nav"
        dense
        sx={{
          flexGrow: 1,
          overflowY: "auto",
          "&::-webkit-scrollbar": {
            width: "0.4em",
          },
          "&::-webkit-scrollbar-track": {
            boxShadow: "inset 0 0 6px rgba(0,0,0,0.00)",
            webkitBoxShadow: "inset 0 0 6px rgba(0,0,0,0.00)",
          },
          "&::-webkit-scrollbar-thumb": {
            backgroundColor: "rgba(0,0,0,.1)",
            outline: "1px solid slategrey",
          },
        }}
      >
        {loading
          ? renderSkeletonItems()
          : consoleEntries.length > 0
            ? renderTree(consoleEntries)
            : !error && (
                <Typography
                  sx={{ p: 2, textAlign: "center", color: "text.secondary" }}
                  variant="body2"
                >
                  No consoles found.
                </Typography>
              )}
      </List>

      {/* Add Menu */}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
      >
        <MenuItem onClick={handleCreateFolder}>
          <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
          New Folder
        </MenuItem>
      </Menu>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleContextMenuClose}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={() => contextMenu && handleRename(contextMenu.item)}>
          <EditIcon sx={{ mr: 1 }} fontSize="small" />
          Rename
        </MenuItem>
        <MenuItem onClick={() => contextMenu && handleDelete(contextMenu.item)}>
          <DeleteIcon sx={{ mr: 1 }} fontSize="small" />
          Delete
        </MenuItem>
        {contextMenu?.item.isDirectory && (
          <MenuItem
            onClick={() => {
              if (contextMenu.item.id) {
                handleCreateFolderInParent(contextMenu.item.id);
              }
              handleContextMenuClose();
            }}
          >
            <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
            New Subfolder
          </MenuItem>
        )}
      </Menu>

      {/* Create Folder Dialog */}
      <Dialog
        open={folderDialogOpen}
        onClose={handleFolderDialogClose}
        maxWidth="sm"
        fullWidth
        TransitionProps={{
          onEntered: () => {
            // Force focus on the text field after dialog animation completes
            setTimeout(() => {
              const input = document.querySelector(
                'input[name="folderName"]',
              ) as HTMLInputElement;
              if (input) {
                input.focus();
                input.select();
              }
            }, 100);
          },
        }}
      >
        <DialogTitle>
          {selectedParentFolder ? "Create New Subfolder" : "Create New Folder"}
        </DialogTitle>
        <DialogContent>
          <TextField
            name="folderName"
            autoFocus
            margin="dense"
            label="Folder Name"
            fullWidth
            variant="outlined"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && newFolderName.trim()) {
                handleFolderCreate();
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            helperText="Organize your consoles by creating folders. Right-click folders to create subfolders."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleFolderDialogClose}>Cancel</Button>
          <Button
            onClick={handleFolderCreate}
            disabled={!newFolderName.trim()}
            variant="contained"
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={renameDialogOpen}
        onClose={() => setRenameDialogOpen(false)}
        maxWidth="sm"
        fullWidth
        TransitionProps={{
          onEntered: () => {
            // Force focus on the text field after dialog animation completes
            setTimeout(() => {
              const input = document.querySelector(
                'input[name="itemName"]',
              ) as HTMLInputElement;
              if (input) {
                input.focus();
                input.select();
              }
            }, 100);
          },
        }}
      >
        <DialogTitle>
          Rename {selectedItem?.isDirectory ? "Folder" : "Console"}
        </DialogTitle>
        <DialogContent>
          <TextField
            name="itemName"
            autoFocus
            margin="dense"
            label="Name"
            fullWidth
            variant="outlined"
            value={newItemName}
            onChange={e => setNewItemName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && newItemName.trim()) {
                handleRenameConfirm();
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            helperText={
              selectedItem?.isDirectory
                ? "Enter the new folder name"
                : "Enter the new console name. Use 'folder/name' to move to a folder."
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleRenameConfirm}
            disabled={!newItemName.trim()}
            variant="contained"
          >
            Rename
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Delete {selectedItem?.isDirectory ? "Folder" : "Console"}
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {selectedItem?.isDirectory
              ? "This will permanently delete the folder and all its contents (subfolders and consoles)."
              : "This will permanently delete the console."}
          </Alert>
          <Typography>
            Are you sure you want to delete &ldquo;{selectedItem?.name}&rdquo;?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default forwardRef(ConsoleExplorer);
