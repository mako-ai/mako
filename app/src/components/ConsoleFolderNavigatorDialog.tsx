import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Breadcrumbs,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  ChevronRight as ChevronRightIcon,
  FolderClosed as FolderIcon,
  Home as HomeIcon,
  Plus as AddIcon,
} from "lucide-react";
import type { ConsoleEntry } from "../store/consoleTreeStore";

export type ConsoleScope = "my" | "workspace";

interface FolderPickResult {
  scope: ConsoleScope;
  folderId: string | null;
  folderPath: string;
  name?: string;
}

interface ConsoleFolderNavigatorDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  myConsoles: ConsoleEntry[];
  sharedWithWorkspace: ConsoleEntry[];
  showNameField?: boolean;
  nameLabel?: string;
  initialName?: string;
  initialScope?: ConsoleScope;
  initialFolderId?: string | null;
  disableScopeSwitch?: boolean;
  onClose: () => void;
  onConfirm: (result: FolderPickResult) => void;
  onCreateFolder?: (
    name: string,
    parentId: string | null,
    scope: ConsoleScope,
  ) => Promise<boolean>;
}

interface FolderNode {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
}

const ROOT_KEY = "__root__";

function indexFolders(
  nodes: ConsoleEntry[],
  parentId: string | null = null,
  acc: FolderNode[] = [],
): FolderNode[] {
  for (const node of nodes) {
    if (!node.isDirectory || !node.id) continue;
    acc.push({
      id: node.id,
      name: node.name,
      path: node.path,
      parentId,
    });
    indexFolders(node.children || [], node.id, acc);
  }
  return acc;
}

export default function ConsoleFolderNavigatorDialog({
  open,
  title,
  confirmLabel,
  myConsoles,
  sharedWithWorkspace,
  showNameField = false,
  nameLabel = "Console name",
  initialName = "",
  initialScope = "my",
  initialFolderId = null,
  disableScopeSwitch = false,
  onClose,
  onConfirm,
  onCreateFolder,
}: ConsoleFolderNavigatorDialogProps) {
  const [scope, setScope] = useState<ConsoleScope>(initialScope);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(
    initialFolderId,
  );
  const [name, setName] = useState(initialName);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (!open) return;
    setScope(initialScope);
    setCurrentFolderId(initialFolderId);
    setName(initialName);
    setNewFolderName("");
  }, [open, initialScope, initialFolderId, initialName]);

  const indexed = useMemo(() => {
    const my = indexFolders(myConsoles);
    const workspace = indexFolders(sharedWithWorkspace);

    const toMaps = (folders: FolderNode[]) => {
      const byId = new Map<string, FolderNode>();
      const childrenByParent = new Map<string, FolderNode[]>();

      for (const folder of folders) {
        byId.set(folder.id, folder);
        const key = folder.parentId || ROOT_KEY;
        const list = childrenByParent.get(key) || [];
        list.push(folder);
        childrenByParent.set(key, list);
      }

      childrenByParent.forEach(children =>
        children.sort((a, b) => a.name.localeCompare(b.name)),
      );

      return { byId, childrenByParent };
    };

    return {
      my: toMaps(my),
      workspace: toMaps(workspace),
    };
  }, [myConsoles, sharedWithWorkspace]);

  const activeIndex = scope === "my" ? indexed.my : indexed.workspace;
  const currentChildren = activeIndex.childrenByParent.get(
    currentFolderId || ROOT_KEY,
  );

  const breadcrumbs = useMemo(() => {
    const items: Array<{ id: string | null; label: string }> = [
      {
        id: null,
        label: scope === "my" ? "My Consoles" : "Shared with Workspace",
      },
    ];

    let cursorId = currentFolderId;
    const chain: FolderNode[] = [];
    while (cursorId) {
      const folder = activeIndex.byId.get(cursorId);
      if (!folder) break;
      chain.unshift(folder);
      cursorId = folder.parentId;
    }

    for (const folder of chain) {
      items.push({ id: folder.id, label: folder.name });
    }

    return items;
  }, [activeIndex.byId, currentFolderId, scope]);

  const handleConfirm = () => {
    const selectedFolder = currentFolderId
      ? activeIndex.byId.get(currentFolderId)
      : null;
    const folderPath = selectedFolder?.path || "";

    onConfirm({
      scope,
      folderId: currentFolderId,
      folderPath,
      name: showNameField ? name.trim() : undefined,
    });
  };

  const handleCreateFolder = async () => {
    if (!onCreateFolder || !newFolderName.trim()) return;
    const ok = await onCreateFolder(
      newFolderName.trim(),
      currentFolderId,
      scope,
    );
    if (ok) {
      setNewFolderName("");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {!disableScopeSwitch && (
          <Tabs
            value={scope}
            onChange={(_, value) => {
              setScope(value as ConsoleScope);
              setCurrentFolderId(null);
            }}
            sx={{ mb: 1 }}
          >
            <Tab value="my" label="My Consoles" />
            <Tab value="workspace" label="Shared with Workspace" />
          </Tabs>
        )}

        <Breadcrumbs sx={{ mb: 1 }}>
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <Button
                key={`${crumb.label}-${index}`}
                size="small"
                onClick={() => setCurrentFolderId(crumb.id)}
                disabled={isLast}
                sx={{ minWidth: 0, p: 0.5 }}
              >
                {index === 0 ? (
                  <HomeIcon size={14} style={{ marginRight: 6 }} />
                ) : null}
                {crumb.label}
              </Button>
            );
          })}
        </Breadcrumbs>

        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            minHeight: 220,
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          <List dense disablePadding>
            {(currentChildren || []).map(folder => (
              <ListItemButton
                key={folder.id}
                onClick={() => setCurrentFolderId(folder.id)}
              >
                <ListItemIcon sx={{ minWidth: 28 }}>
                  <FolderIcon size={16} />
                </ListItemIcon>
                <ListItemText primary={folder.name} />
                <ChevronRightIcon size={16} />
              </ListItemButton>
            ))}
            {!currentChildren?.length && (
              <Typography
                variant="body2"
                sx={{
                  px: 2,
                  py: 1.5,
                  color: "text.secondary",
                  fontStyle: "italic",
                }}
              >
                No folders here
              </Typography>
            )}
          </List>
        </Box>

        {onCreateFolder && (
          <Box sx={{ mt: 1.5, display: "flex", gap: 1 }}>
            <TextField
              size="small"
              label="New folder"
              fullWidth
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  void handleCreateFolder();
                }
              }}
            />
            <Button
              variant="outlined"
              onClick={() => void handleCreateFolder()}
              disabled={!newFolderName.trim()}
              startIcon={<AddIcon size={14} />}
            >
              New Folder
            </Button>
          </Box>
        )}

        {showNameField && (
          <TextField
            sx={{ mt: 2 }}
            fullWidth
            label={nameLabel}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && name.trim()) {
                handleConfirm();
              }
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={showNameField ? !name.trim() : false}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
