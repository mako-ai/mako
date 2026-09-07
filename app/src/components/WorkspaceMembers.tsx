import { useEffect, useMemo, useState } from "react";
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
import {
  COUNTRY_CODES,
  JOB_ROLES,
  JOB_ROLE_LABELS,
  type JobRole,
} from "@mako/schemas";
import { useWorkspace } from "../contexts/workspace-context";
import { workspaceClient } from "../lib/workspace-client";
import { useAuth } from "../contexts/auth-context";
import { trackEvent } from "../lib/analytics";
import { useConfirm } from "./ConfirmDialog";

interface MemberRow {
  id: string;
  email: string;
  role: string;
  /** Job role + country: what published apps scope their data by. */
  jobRole: JobRole | null;
  country: string | null;
  /** Auto-joined, waiting for an admin to set the job role. */
  profilePending?: boolean;
  status: "active" | "pending";
  joinedAt?: string;
  expiresAt?: string;
  userId?: string;
  token?: string;
}

const countryNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;
function countryName(code: string): string {
  try {
    return countryNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function WorkspaceMembers() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const {
    currentWorkspace,
    members,
    invites,
    inviteMember,
    updateMember,
    updateMemberRole,
    removeMember,
    cancelInvite,
  } = useWorkspace();

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );
  const [inviteJobRole, setInviteJobRole] = useState<JobRole | "">("");
  const [inviteCountry, setInviteCountry] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleInviteMember = async () => {
    if (!inviteEmail.trim()) {
      setError("Email is required");
      return;
    }
    if (!inviteJobRole) {
      setError("Job role is required — apps scope their data by it");
      return;
    }

    setInviting(true);
    setError(null);

    try {
      await inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
        jobRole: inviteJobRole,
        ...(inviteCountry ? { country: inviteCountry } : {}),
      });

      // Track invite sent
      trackEvent("invite_sent", {
        invite_role: inviteRole,
      });

      setInviteDialogOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      setInviteJobRole("");
      setInviteCountry("");
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
    if (!userId) {
      setError("Cannot update role for a member with missing user details");
      return;
    }

    try {
      await updateMemberRole(userId, newRole);
    } catch (error: any) {
      setError(error.message || "Failed to update role");
    }
  };

  const handleProfileChange = async (
    userId: string,
    patch: { jobRole?: JobRole | null; country?: string | null },
  ) => {
    if (!userId) {
      setError("Cannot update a member with missing user details");
      return;
    }
    try {
      await updateMember(userId, patch);
    } catch (error: any) {
      setError(error.message || "Failed to update member");
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!userId) {
      setError("Cannot remove a member with missing user details");
      return;
    }

    if (
      !(await confirm({
        title: "Remove member?",
        body: "Are you sure you want to remove this member?",
        confirmLabel: "Remove",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await removeMember(userId);
    } catch (error: any) {
      setError(error.message || "Failed to remove member");
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
      email: member.email ?? "",
      role: member.role,
      jobRole: member.jobRole ?? null,
      country: member.country ?? null,
      profilePending: member.profilePending === true,
      status: "active" as const,
      joinedAt: member.joinedAt,
      userId: member.userId,
    }));

    const inviteRows: MemberRow[] = invites.map(invite => ({
      id: invite.id,
      email: invite.email ?? "",
      role: invite.role,
      jobRole: invite.jobRole ?? null,
      country: invite.country ?? null,
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
      {canManageMembers && (
        <Box
          sx={{
            mb: 2,
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          <Button
            variant="contained"
            size="small"
            startIcon={<PersonAdd />}
            onClick={() => setInviteDialogOpen(true)}
          >
            Invite Member
          </Button>
        </Box>
      )}

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

      {canManageMembers && <AutoJoinCard workspaceId={currentWorkspace.id} />}

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
                Access
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Job role
              </TableCell>
              <TableCell sx={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Country
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
              const displayEmail = row.email || "Unknown user";
              const avatarLabel =
                displayEmail.trim().charAt(0).toUpperCase() || "?";
              const rowDate =
                row.status === "active" ? row.joinedAt : row.expiresAt;
              const formattedDate = rowDate
                ? new Date(rowDate).toLocaleDateString()
                : "Unknown";
              const isCurrentUser = row.email === user?.email;
              const isOwner = row.role === "owner";
              const canEdit = canManageMembers && !isOwner && !isCurrentUser;
              // Job role and country are a profile, not a permission: an
              // admin may set them on anyone, the owner and themselves included.
              const canEditProfile =
                canManageMembers && row.status === "active" && !!row.userId;

              return (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <Avatar
                        sx={{ width: 32, height: 32, fontSize: "0.875rem" }}
                      >
                        {row.status === "pending" ? <Email /> : avatarLabel}
                      </Avatar>
                      <Typography variant="body2">{displayEmail}</Typography>
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
                    {canEditProfile ? (
                      <FormControl size="small" sx={{ minWidth: 130 }}>
                        <Select
                          value={row.jobRole ?? ""}
                          displayEmpty
                          onChange={e =>
                            handleProfileChange(row.userId ?? "", {
                              jobRole: (e.target.value ||
                                null) as JobRole | null,
                            })
                          }
                          size="small"
                          variant="standard"
                          renderValue={value =>
                            value ? (
                              JOB_ROLE_LABELS[value as JobRole]
                            ) : (
                              <Typography
                                variant="caption"
                                color="warning.main"
                              >
                                Not set
                              </Typography>
                            )
                          }
                        >
                          <MenuItem value="">
                            <em>Not set</em>
                          </MenuItem>
                          {JOB_ROLES.map(role => (
                            <MenuItem key={role} value={role}>
                              {JOB_ROLE_LABELS[role]}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    ) : row.jobRole ? (
                      <Chip label={JOB_ROLE_LABELS[row.jobRole]} size="small" />
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        —
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {canEditProfile ? (
                      <FormControl size="small" sx={{ minWidth: 70 }}>
                        <Select
                          value={row.country ?? ""}
                          displayEmpty
                          onChange={e =>
                            handleProfileChange(row.userId ?? "", {
                              country: e.target.value || null,
                            })
                          }
                          size="small"
                          variant="standard"
                          renderValue={value => (value ? String(value) : "—")}
                          MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
                        >
                          <MenuItem value="">
                            <em>Not set</em>
                          </MenuItem>
                          {COUNTRY_CODES.map(code => (
                            <MenuItem key={code} value={code}>
                              {code} · {countryName(code)}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    ) : (
                      <Typography variant="body2">
                        {row.country ?? "—"}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={
                        row.profilePending ? "waiting for role" : row.status
                      }
                      size="small"
                      variant="outlined"
                      color={
                        row.profilePending
                          ? "warning"
                          : row.status === "active"
                            ? "success"
                            : "warning"
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {row.status === "active" ? "Joined" : "Expires"}{" "}
                      {formattedDate}
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
          <Box sx={{ display: "flex", gap: 2, mt: 2 }}>
            <FormControl fullWidth variant="outlined" required>
              <InputLabel>Job role</InputLabel>
              <Select
                value={inviteJobRole}
                onChange={e => setInviteJobRole(e.target.value as JobRole)}
                label="Job role"
                disabled={inviting}
              >
                {JOB_ROLES.map(role => (
                  <MenuItem key={role} value={role}>
                    {JOB_ROLE_LABELS[role]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth variant="outlined">
              <InputLabel>Country</InputLabel>
              <Select
                value={inviteCountry}
                onChange={e => setInviteCountry(e.target.value)}
                label="Country"
                disabled={inviting}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
              >
                <MenuItem value="">
                  <em>Not set</em>
                </MenuItem>
                {COUNTRY_CODES.map(code => (
                  <MenuItem key={code} value={code}>
                    {code} · {countryName(code)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 2, display: "block" }}
          >
            Apps scope their data by job role and country — a member without a
            job role sees nothing that is scoped. An invitation email will be
            sent to the provided address.
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
            disabled={inviting || !inviteEmail.trim() || !inviteJobRole}
          >
            {inviting ? <CircularProgress size={20} /> : "Send Invitation"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/**
 * Domain auto-join: anyone signing in with an email on these domains joins
 * the workspace on first contact — no invitation — with these defaults. The
 * way a rep clicks a published app's link, signs in with Google, and lands
 * on their own view.
 */
function AutoJoinCard({ workspaceId }: { workspaceId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [domains, setDomains] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("viewer");
  const [jobRole, setJobRole] = useState<JobRole | "">("");
  const [country, setCountry] = useState("");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [slackConfigured, setSlackConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    workspaceClient
      .getAutoJoin(workspaceId)
      .then(current => {
        if (cancelled) return;
        setDomains(current?.domains.join(", ") ?? "");
        setRole(current?.role ?? "viewer");
        setJobRole(current?.jobRole ?? "");
        setCountry(current?.country ?? "");
        setSlackConfigured(!!current?.slackWebhookConfigured);
      })
      .catch((e: any) => setError(e.message || "Failed to load auto-join"))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const list = domains
        .split(/[,\s]+/)
        .map(d => d.trim())
        .filter(Boolean);
      const saved = await workspaceClient.setAutoJoin(workspaceId, {
        domains: list,
        role,
        jobRole: jobRole || null,
        country: country || null,
        ...(slackWebhook.trim()
          ? { slackWebhookUrl: slackWebhook.trim() }
          : {}),
      });
      setSlackConfigured(!!saved?.slackWebhookConfigured);
      setSlackWebhook("");
      setMessage(
        saved
          ? `Anyone with an email on ${saved.domains.join(", ")} now joins as ${saved.role}` +
              (saved.jobRole
                ? ` · ${JOB_ROLE_LABELS[saved.jobRole]}` +
                  (saved.country ? ` · ${saved.country}` : "") +
                  " the first time they open the workspace or one of its apps."
                : " and WAITS until an admin sets their job role here" +
                  (saved.slackWebhookConfigured
                    ? " — Slack is told each time."
                    : " — add a Slack webhook to be told each time."))
          : "Auto-join is off.",
      );
      setTimeout(() => setMessage(null), 6000);
    } catch (e: any) {
      setError(e.message || "Failed to save auto-join");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        mb: 2,
        boxShadow: "none",
        border: "1px solid rgba(224, 224, 224, 1)",
      }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Auto-join by email domain
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1.5 }}
      >
        People who sign in with an email on these domains become members the
        first time they open the workspace or one of its apps — no invitation
        needed. With a job role below they are in at once; with none they see a
        &quot;please wait for an administrator&quot; page, the Slack channel is
        told to assign their role and country, and they get an email once you
        do. Leave the domains empty to turn it off.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {message && (
        <Alert
          severity="success"
          sx={{ mb: 1.5 }}
          onClose={() => setMessage(null)}
        >
          {message}
        </Alert>
      )}
      <Box
        sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}
      >
        <TextField
          size="small"
          label="Domains"
          placeholder="acme.com, acme.ch"
          value={domains}
          onChange={e => setDomains(e.target.value)}
          disabled={!loaded || saving}
          sx={{ minWidth: 260, flex: 1 }}
        />
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>Access</InputLabel>
          <Select
            value={role}
            label="Access"
            onChange={e => setRole(e.target.value as "member" | "viewer")}
            disabled={!loaded || saving}
          >
            <MenuItem value="viewer">Viewer</MenuItem>
            <MenuItem value="member">Member</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Job role</InputLabel>
          <Select
            value={jobRole}
            label="Job role"
            onChange={e => setJobRole(e.target.value as JobRole | "")}
            disabled={!loaded || saving}
          >
            <MenuItem value="">
              <em>Not set</em>
            </MenuItem>
            {JOB_ROLES.map(r => (
              <MenuItem key={r} value={r}>
                {JOB_ROLE_LABELS[r]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 110 }}>
          <InputLabel>Country</InputLabel>
          <Select
            value={country}
            label="Country"
            onChange={e => setCountry(e.target.value)}
            disabled={!loaded || saving}
            MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
          >
            <MenuItem value="">
              <em>Not set</em>
            </MenuItem>
            {COUNTRY_CODES.map(code => (
              <MenuItem key={code} value={code}>
                {code} · {countryName(code)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained"
          size="small"
          onClick={save}
          disabled={!loaded || saving}
        >
          {saving ? <CircularProgress size={18} /> : "Save"}
        </Button>
      </Box>
      <TextField
        size="small"
        fullWidth
        sx={{ mt: 1.5 }}
        label={
          slackConfigured
            ? "Slack incoming webhook (configured — paste a new one to replace)"
            : "Slack incoming webhook (optional) — #mako-internal-signup"
        }
        placeholder="https://hooks.slack.com/services/…"
        value={slackWebhook}
        onChange={e => setSlackWebhook(e.target.value)}
        disabled={!loaded || saving}
      />
    </Paper>
  );
}
