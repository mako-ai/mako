import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Autocomplete,
  TextField,
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  IconButton,
  Chip,
  Alert,
  Tooltip,
} from "@mui/material";
import { Trash2, UserPlus } from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { useAuth } from "../../contexts/auth-context";

interface DashboardShareDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

export default function DashboardShareDialog({
  open,
  onClose,
  dashboardId,
}: DashboardShareDialogProps) {
  const { user } = useAuth();
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const dashboard = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId] : undefined,
  );
  const shareDashboard = useDashboardStore(s => s.shareDashboard);
  const unshareDashboard = useDashboardStore(s => s.unshareDashboard);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setSelectedUserId(null);
      void loadMembers();
    }
  }, [open, loadMembers]);

  const ownerId = dashboard?.owner_id || dashboard?.createdBy;
  const sharedUserIds = useMemo(
    () => new Set((dashboard?.sharedWith || []).map(s => s.userId)),
    [dashboard?.sharedWith],
  );

  const emailByUserId = useMemo(
    () => new Map(members.map(m => [m.userId, m.email])),
    [members],
  );

  // Members eligible to be added: not the owner and not already shared.
  const addableMembers = useMemo(
    () =>
      members.filter(m => m.userId !== ownerId && !sharedUserIds.has(m.userId)),
    [members, ownerId, sharedUserIds],
  );

  const collaborators = dashboard?.sharedWith || [];

  const handleAdd = async () => {
    if (!workspaceId || !dashboardId || !selectedUserId) return;
    setBusy(true);
    setError(null);
    const result = await shareDashboard(
      workspaceId,
      dashboardId,
      selectedUserId,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to share dashboard");
      return;
    }
    setSelectedUserId(null);
  };

  const handleRemove = async (targetUserId: string) => {
    if (!workspaceId || !dashboardId) return;
    setBusy(true);
    setError(null);
    const result = await unshareDashboard(
      workspaceId,
      dashboardId,
      targetUserId,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to remove collaborator");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Share dashboard</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          People you add here can view and edit this dashboard, regardless of
          its workspace visibility setting.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Add people
        </Typography>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", mb: 3 }}>
          <Autocomplete
            sx={{ flex: 1 }}
            options={addableMembers}
            getOptionLabel={option => option.email || option.userId}
            value={
              addableMembers.find(m => m.userId === selectedUserId) ?? null
            }
            onChange={(_, value) => setSelectedUserId(value?.userId ?? null)}
            isOptionEqualToValue={(option, value) =>
              option.userId === value.userId
            }
            renderInput={params => (
              <TextField
                {...params}
                placeholder="Search members by email"
                size="small"
              />
            )}
            disabled={busy}
          />
          <Button
            variant="contained"
            startIcon={<UserPlus size={16} />}
            onClick={handleAdd}
            disabled={!selectedUserId || busy}
          >
            Add
          </Button>
        </Box>

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          People with access
        </Typography>

        <List dense disablePadding>
          <ListItem
            disableGutters
            secondaryAction={<Chip size="small" label="Owner" />}
          >
            <ListItemText
              primary={
                ownerId === user?.id
                  ? "You"
                  : emailByUserId.get(ownerId || "") || ownerId
              }
            />
          </ListItem>

          {collaborators.length === 0 && (
            <ListItem disableGutters>
              <ListItemText
                primaryTypographyProps={{
                  variant: "body2",
                  color: "text.secondary",
                }}
                primary="Not shared with anyone yet."
              />
            </ListItem>
          )}

          {collaborators.map(collab => (
            <ListItem
              key={collab.userId}
              disableGutters
              secondaryAction={
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip size="small" label="Editor" variant="outlined" />
                  <Tooltip title="Remove access">
                    <span>
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => handleRemove(collab.userId)}
                        disabled={busy}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              }
            >
              <ListItemText
                primary={emailByUserId.get(collab.userId) || collab.userId}
              />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
