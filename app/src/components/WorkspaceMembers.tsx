import { useState, useMemo } from "react";
import {
  Box,
  Typography,
  Button,
  Select,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Chip,
  CircularProgress,
  Alert,
  Tooltip,
  FormControl,
  InputLabel,
  IconButton,
  Avatar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
} from "@mui/material";
import {
  PersonAdd,
  Delete,
  Email,
  ContentCopy,
  Close,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { trackEvent } from "../lib/analytics";

interface MemberRow {
  id: string;
  email: string;
  role: string;
  status: "active" | "pending";
  joinedAt?: string;
  expiresAt?: string;
  userId?: string;
  token?: string;
}

export function WorkspaceMembers() {
  const { user } = useAuth();
  const {
    currentWorkspace,
    members,
    invites,
    inviteMember,
    updateMemberRole,
    removeMember,
    cancelInvite,
  } = useWorkspace();

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleInviteMember = async () => {
    if (!inviteEmail.trim()) {
      setError("Email is required");
      return;
    }

    setInviting(true);
    setError(null);

    try {
      await inviteMember({ email: inviteEmail.trim(), role: inviteRole });

      // Track invite sent
      trackEvent("invite_sent", {
        invite_role: inviteRole,
      });

      setInviteDialogOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      setSuccessMessage("Invitation sent successfully");
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (error: any) {
      setError(error.message || "Failed to send invitation");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (
    userId: string,
    newRole: "admin" | "member" | "viewer",
  ) => {
    try {
      await updateMemberRole(userId, newRole);
    } catch (error: any) {
      setError(error.message || "Failed to update role");
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (window.confirm("Are you sure you want to remove this member?")) {
      try {
        await removeMember(userId);
      } catch (error: any) {
        setError(error.message || "Failed to remove member");
      }
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    try {
      await cancelInvite(inviteId);
    } catch (error: any) {
      setError(error.message || "Failed to cancel invitation");
    }
  };

  const copyInviteLink = (token: string) => {
    const inviteUrl = `${window.location.origin}/invite/${token}`;
    navigator.clipboard.writeText(inviteUrl);
    setSuccessMessage("Invite link copied to clipboard");
    setTimeout(() => setSuccessMessage(null), 3000);
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

  const currentUserRole = members.find(m => m.email === user?.email)?.role;
  const canManageMembers =
    currentUserRole === "owner" || currentUserRole === "admin";

  // Combine members and invites into a single dataset
  const rows: MemberRow[] = useMemo(() => {
    const memberRows: MemberRow[] = members.map(member => ({
      id: member.id,
      email: member.email,
      role: member.role,
      status: "active" as const,
      joinedAt: member.joinedAt,
      userId: member.userId,
    }));

    const inviteRows: MemberRow[] = invites.map(invite => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      status: "pending" as const,
      expiresAt: invite.expiresAt,
      token: invite.token,
    }));

    return [...memberRows, ...inviteRows];
  }, [members, invites]);

  if (!currentWorkspace) {
    return (
      <Alert severity="info">Please select a workspace to view members</Alert>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          mb: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Workspace Members
        </Typography>
        {canManageMembers && (
          <Button
            variant="contained"
            size="small"
            startIcon={<PersonAdd />}
            onClick={() => setInviteDialogOpen(true)}
          >
            Invite Member
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {successMessage && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setSuccessMessage(null)}
        >
          {successMessage}
        </Alert>
      )}

      <TableContainer
        component={Paper}
        sx={{ boxShadow: "none", border: "1px solid rgba(224, 224, 224, 1)" }}
      >
        <Table size="small">
          <TableHead>
            <TableRow sx={{ backgroundColor: "rgba(0, 0, 0, 0.04)" }}>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Email
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Role
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Status
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Date
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Actions
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(row => {
              const isCurrentUser = row.email === user?.email;
              const isOwner = row.role === "owner";
              const canEdit = canManageMembers && !isOwner && !isCurrentUser;

              return (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <Avatar
                        sx={{ width: 32, height: 32, fontSize: "0.875rem" }}
                      >
                        {row.status === "pending" ? (
                          <Email />
                        ) : (
                          row.email[0].toUpperCase()
                        )}
                      </Avatar>
                      <Typography variant="body2">{row.email}</Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={row.role}
                      size="small"
                      color={getRoleBadgeColor(row.role)}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={row.status}
                      size="small"
                      variant="outlined"
                      color={row.status === "active" ? "success" : "warning"}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {row.status === "active" ? "Joined" : "Expires"}{" "}
                      {new Date(
                        row.status === "active"
                          ? (row.joinedAt ?? "")
                          : (row.expiresAt ?? ""),
                      ).toLocaleDateString()}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {row.status === "pending" && canManageMembers ? (
                      <Box sx={{ display: "flex", gap: 0.5 }}>
                        {row.token && (
                          <Tooltip title="Copy invite link">
                            <IconButton
                              size="small"
                              onClick={() => copyInviteLink(row.token ?? "")}
                            >
                              <ContentCopy fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title="Cancel invitation">
                          <IconButton
                            size="small"
                            onClick={() => handleCancelInvite(row.id)}
                            color="error"
                          >
                            <Close fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ) : canEdit ? (
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                      >
                        <FormControl size="small" sx={{ minWidth: 80 }}>
                          <Select
                            value={row.role}
                            onChange={e =>
                              handleRoleChange(
                                row.userId ?? "",
                                e.target.value as "admin" | "member" | "viewer",
                              )
                            }
                            size="small"
                            variant="standard"
                          >
                            <MenuItem value="admin">Admin</MenuItem>
                            <MenuItem value="member">Member</MenuItem>
                            <MenuItem value="viewer">Viewer</MenuItem>
                          </Select>
                        </FormControl>
                        <Tooltip title="Remove member">
                          <IconButton
                            size="small"
                            onClick={() => handleRemoveMember(row.userId ?? "")}
                            color="error"
                          >
                            <Delete fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Invite Member Dialog */}
      <Dialog
        open={inviteDialogOpen}
        onClose={() => !inviting && setInviteDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Invite Member</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Email Address"
            type="email"
            fullWidth
            variant="outlined"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            disabled={inviting}
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth variant="outlined">
            <InputLabel>Role</InputLabel>
            <Select
              value={inviteRole}
              onChange={e =>
                setInviteRole(e.target.value as "admin" | "member" | "viewer")
              }
              label="Role"
              disabled={inviting}
            >
              <MenuItem value="admin">
                Admin - Can manage workspace settings and members
              </MenuItem>
              <MenuItem value="member">
                Member - Can create and manage resources
              </MenuItem>
              <MenuItem value="viewer">Viewer - Read-only access</MenuItem>
            </Select>
          </FormControl>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 2, display: "block" }}
          >
            An invitation email will be sent to the provided address.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setInviteDialogOpen(false)}
            disabled={inviting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleInviteMember}
            variant="contained"
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? <CircularProgress size={20} /> : "Send Invitation"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
