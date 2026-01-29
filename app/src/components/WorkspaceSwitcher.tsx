import React, { useState } from "react";
import {
  Box,
  Button,
  Menu,
  MenuItem,
  Typography,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Chip,
  CircularProgress,
  ListItemIcon,
  ListItemText,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  KeyboardArrowDown,
  Add,
  Check,
  Settings,
  Business,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { trackEvent } from "../lib/analytics";

export function WorkspaceSwitcher() {
  const { user } = useAuth();
  const {
    workspaces,
    currentWorkspace,
    loading,
    createWorkspace,
    switchWorkspace,
  } = useWorkspace();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleSwitchWorkspace = async (workspaceId: string) => {
    handleClose();
    if (workspaceId !== currentWorkspace?.id) {
      await switchWorkspace(workspaceId);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      setCreateError("Workspace name is required");
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const workspace = await createWorkspace({
        name: newWorkspaceName.trim(),
      });

      // Track workspace creation
      trackEvent("workspace_created", {
        workspace_id: workspace.id,
        is_onboarding: false,
      });

      setCreateDialogOpen(false);
      setNewWorkspaceName("");
      handleClose();
    } catch (error: any) {
      setCreateError(error.message || "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case "owner":
        return "error";
      case "admin":
        return "warning";
      case "member":
        return "primary";
      case "viewer":
        return "default";
      default:
        return "default";
    }
  };

  if (loading) {
    return <CircularProgress size={20} />;
  }

  return (
    <>
      <Button
        onClick={handleClick}
        startIcon={<Business />}
        endIcon={<KeyboardArrowDown />}
        sx={{
          textTransform: "none",
          color: "text.primary",
          minWidth: 200,
          justifyContent: "space-between",
          px: 2,
        }}
      >
        <Box sx={{ textAlign: "left", flex: 1 }}>
          <Typography variant="body2" noWrap>
            {currentWorkspace?.name || "Select Workspace"}
          </Typography>
          {currentWorkspace && (
            <Typography variant="caption" color="text.secondary">
              {currentWorkspace.role}
            </Typography>
          )}
        </Box>
      </Button>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleClose}
        PaperProps={{
          sx: { minWidth: 280, maxHeight: 400 },
        }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {user?.email}
          </Typography>
        </Box>
        <Divider />

        {workspaces.map(workspace => (
          <MenuItem
            key={workspace.id}
            onClick={() => handleSwitchWorkspace(workspace.id)}
            selected={workspace.id === currentWorkspace?.id}
          >
            <ListItemIcon>
              {workspace.id === currentWorkspace?.id && <Check />}
            </ListItemIcon>
            <ListItemText
              primary={workspace.name}
              secondary={
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mt: 0.5,
                  }}
                >
                  <Chip
                    label={workspace.role}
                    size="small"
                    color={getRoleBadgeColor(workspace.role)}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {workspace.settings.billingTier}
                  </Typography>
                </Box>
              }
            />
            {(workspace.role === "owner" || workspace.role === "admin") && (
              <Tooltip title="Workspace Settings">
                <IconButton
                  size="small"
                  onClick={e => {
                    e.stopPropagation();
                    // TODO: Navigate to workspace settings
                    // Placeholder for future implementation
                    void workspace.id;
                  }}
                >
                  <Settings fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </MenuItem>
        ))}

        <Divider sx={{ my: 1 }} />

        <MenuItem onClick={() => setCreateDialogOpen(true)}>
          <ListItemIcon>
            <Add />
          </ListItemIcon>
          <ListItemText primary="Create New Workspace" />
        </MenuItem>
      </Menu>

      {/* Create Workspace Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => !creating && setCreateDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create New Workspace</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Workspace Name"
            type="text"
            fullWidth
            variant="outlined"
            value={newWorkspaceName}
            onChange={e => setNewWorkspaceName(e.target.value)}
            error={Boolean(createError)}
            helperText={createError}
            disabled={creating}
            onKeyPress={e => {
              if (e.key === "Enter" && !creating) {
                handleCreateWorkspace();
              }
            }}
            sx={{ mt: 2 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
            You can invite team members after creating the workspace.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setCreateDialogOpen(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateWorkspace}
            variant="contained"
            disabled={creating || !newWorkspaceName.trim()}
          >
            {creating ? <CircularProgress size={20} /> : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
