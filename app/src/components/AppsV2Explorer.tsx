/**
 * Apps v2 explorer — flat list of git-backed apps (experimental module,
 * parallel to the v1 AppsExplorer). Clicking an app opens its workspace tab
 * (file tree + editor + terminal + preview live inside the tab, not here).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  EllipsisVertical as MoreIcon,
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useAppsV2Store } from "../store/appsV2Store";
import { focusAppsV2Tab } from "../apps-v2-runtime/shell";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import ExplorerShell from "./ExplorerShell";

const AppIcon = TAB_KIND_ICONS["app-v2"];

export default function AppsV2Explorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const apps = useAppsV2Store(s => s.apps);
  const loading = useAppsV2Store(s => s.appsLoading);
  const error = useAppsV2Store(s => s.error);
  const clearError = useAppsV2Store(s => s.clearError);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  const createApp = useAppsV2Store(s => s.createApp);
  const deleteApp = useAppsV2Store(s => s.deleteApp);

  const activeTab = useConsoleStore(s =>
    s.activeTabId ? s.tabs[s.activeTabId] : undefined,
  );
  const activeAppId =
    activeTab?.kind === "app-v2"
      ? (activeTab.metadata?.appV2Id as string | undefined)
      : undefined;

  const reveal = useExplorerRevealStore(selectRevealFor("apps-v2"));
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<null | {
    el: HTMLElement;
    appId: string;
  }>(null);

  useEffect(() => {
    if (workspaceId) void fetchApps(workspaceId);
  }, [workspaceId, fetchApps]);

  useEffect(() => {
    if (!reveal) return;
    rowRefs.current[reveal.nodeId]?.scrollIntoView({ block: "nearest" });
  }, [reveal]);

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !newTitle.trim()) return;
    setCreating(true);
    const app = await createApp(workspaceId, newTitle.trim());
    setCreating(false);
    if (app) {
      setCreateOpen(false);
      setNewTitle("");
      focusAppsV2Tab(app.id, app.title);
    }
  }, [workspaceId, newTitle, createApp]);

  const handleDelete = useCallback(async () => {
    if (!workspaceId || !menuAnchor) return;
    const { appId } = menuAnchor;
    setMenuAnchor(null);
    if (
      !window.confirm(
        "Delete this app and its git repository? This cannot be undone.",
      )
    ) {
      return;
    }
    await deleteApp(workspaceId, appId);
    // Close its tab if open.
    const consoleStore = useConsoleStore.getState();
    const tab = Object.values(consoleStore.tabs).find(
      t => t.kind === "app-v2" && t.metadata?.appV2Id === appId,
    );
    if (tab) consoleStore.closeTab(tab.id);
  }, [workspaceId, menuAnchor, deleteApp]);

  const actions = (
    <>
      <Tooltip title="New app">
        <IconButton size="small" onClick={() => setCreateOpen(true)}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton
          size="small"
          disabled={loading || !workspaceId}
          onClick={() => workspaceId && fetchApps(workspaceId)}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Apps v2"
        actions={actions}
        searchPlaceholder="Search apps..."
        error={error}
        onErrorClose={clearError}
        loading={loading && apps.length === 0}
      >
        {({ searchQuery }) => {
          const visible = searchQuery
            ? apps.filter(a =>
                a.title.toLowerCase().includes(searchQuery.toLowerCase()),
              )
            : apps;
          if (visible.length === 0) {
            return (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2" color="text.secondary">
                  {searchQuery
                    ? "No apps match your search."
                    : "No apps yet. Create one, or ask the agent to build one (Apps v2 tools)."}
                </Typography>
              </Box>
            );
          }
          return (
            <List dense disablePadding>
              {visible.map(app => (
                <ListItemButton
                  key={app.id}
                  ref={el => {
                    rowRefs.current[app.id] = el;
                  }}
                  selected={app.id === activeAppId}
                  onClick={() => focusAppsV2Tab(app.id, app.title)}
                  sx={{ pr: 1 }}
                >
                  <ListItemIcon sx={{ minWidth: 30 }}>
                    <AppIcon size={16} strokeWidth={1.5} />
                  </ListItemIcon>
                  <ListItemText
                    primary={app.title}
                    secondary={app.description || undefined}
                    primaryTypographyProps={{ noWrap: true }}
                    secondaryTypographyProps={{ noWrap: true }}
                  />
                  <IconButton
                    size="small"
                    onClick={e => {
                      e.stopPropagation();
                      setMenuAnchor({ el: e.currentTarget, appId: app.id });
                    }}
                  >
                    <MoreIcon size={16} />
                  </IconButton>
                </ListItemButton>
              ))}
            </List>
          );
        }}
      </ExplorerShell>

      <Menu
        anchorEl={menuAnchor?.el}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
      >
        <MenuItem onClick={handleDelete}>
          <ListItemIcon>
            <DeleteIcon size={16} />
          </ListItemIcon>
          Delete app
        </MenuItem>
      </Menu>

      <Dialog
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New Apps v2 app</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Title"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleCreate();
            }}
            disabled={creating}
          />
          <Typography variant="caption" color="text.secondary">
            Creates a real Vite + React project in a Mako-managed git
            repository.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreate()}
            disabled={creating || !newTitle.trim()}
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
