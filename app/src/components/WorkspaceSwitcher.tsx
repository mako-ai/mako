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
  CircularProgress,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import {
  KeyboardArrowDown,
  Add,
  Check,
  ApartmentRounded,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent } from "../lib/analytics";

export function WorkspaceSwitcher() {
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

  if (loading) {
    return <CircularProgress size={20} />;
  }

  return (
    <>
      <Button
        onClick={handleClick}
        endIcon={
          <KeyboardArrowDown sx={{ fontSize: 18, color: "text.secondary" }} />
        }
        sx={{
          textTransform: "none",
          color: "text.primary",
          width: "100%",
          minWidth: 0,
          justifyContent: "space-between",
          px: 1.25,
          py: 1,
          maxWidth: "100%",
          borderRadius: 2,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
          "&:hover": {
            bgcolor: "action.hover",
            borderColor: "action.selected",
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.25,
            textAlign: "left",
            flex: 1,
            minWidth: 0,
          }}
        >
          <Box
            sx={{
              width: 28,
              height: 28,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              color: "text.secondary",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <ApartmentRounded sx={{ fontSize: 18 }} />
          </Box>
          <Typography
            variant="body2"
            noWrap
            sx={{ fontSize: "0.95rem", fontWeight: 600 }}
          >
            {currentWorkspace?.name || "Select Workspace"}
          </Typography>
        </Box>
      </Button>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleClose}
        PaperProps={{
          sx: { minWidth: 240, maxHeight: 360, py: 0.5 },
        }}
      >
        {workspaces.map(workspace => (
          <MenuItem
            key={workspace.id}
            onClick={() => handleSwitchWorkspace(workspace.id)}
            selected={workspace.id === currentWorkspace?.id}
            sx={{
              minHeight: 40,
              px: 1.5,
              py: 0.75,
            }}
          >
            <ListItemIcon sx={{ minWidth: 24, color: "text.primary" }}>
              {workspace.id === currentWorkspace?.id ? (
                <Check fontSize="small" />
              ) : null}
            </ListItemIcon>
            <ListItemText
              primary={workspace.name}
              primaryTypographyProps={{
                fontSize: "0.9rem",
                fontWeight: workspace.id === currentWorkspace?.id ? 600 : 500,
                lineHeight: 1.3,
              }}
            />
          </MenuItem>
        ))}

        <Divider sx={{ my: 1 }} />

        <MenuItem
          onClick={() => setCreateDialogOpen(true)}
          sx={{ minHeight: 40, px: 1.5, py: 0.75 }}
        >
          <ListItemIcon>
            <Add fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Create New Workspace"
            primaryTypographyProps={{ fontSize: "0.9rem", fontWeight: 500 }}
          />
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
