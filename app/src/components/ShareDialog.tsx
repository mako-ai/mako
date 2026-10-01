import { useCallback, useEffect, useMemo, useState } from "react";
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
  Avatar,
  IconButton,
  Alert,
  Tooltip,
  Select,
  MenuItem,
  Switch,
  InputAdornment,
  CircularProgress,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  Trash2,
  Link as LinkIcon,
  Globe,
  Building2,
  Lock,
  RefreshCw,
  Check,
  X,
  Eye,
  EyeOff,
  Pencil,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import {
  useShareStore,
  shareKey,
  buildPublicShareUrl,
  buildWorkspaceResourceUrl,
  type ShareResourceType,
  type ShareRole,
  type ShareAccess,
  type ShareCollaborator,
  type PublicShareInfo,
  type SharingSettings,
} from "../store/shareStore";

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  resourceType: ShareResourceType;
  resourceId?: string;
  resourceName?: string;
  /** Owner user id (falls back to createdBy upstream). */
  ownerId?: string;
  access?: ShareAccess;
  workspaceRole?: ShareRole;
  publicShare?: PublicShareInfo;
  /** Whether the current user can manage sharing (owner or workspace admin). */
  canManage?: boolean;
  onSharingChanged?: (changes: {
    access?: ShareAccess;
    workspaceRole?: ShareRole;
    publicShare?: PublicShareInfo;
  }) => void;
}

const RESOURCE_LABEL: Record<ShareResourceType, string> = {
  dashboard: "dashboard",
  console: "console",
  app: "app",
};

/** Public links are only available where snapshot data exists. */
const SUPPORTS_PUBLIC: Record<ShareResourceType, boolean> = {
  dashboard: true,
  console: false,
  // A published app is served from its immutable deployment.
  app: true,
};

type AppLinkScope = "workspace" | "public-password" | "public";

// Stable fallback so the Zustand selector never returns a fresh `[]` per call
// (a new reference each render makes useSyncExternalStore loop forever and
// blocks the initial commit — blank page with no error).
const NO_COLLABORATORS: ShareCollaborator[] = [];

// Deterministic per-person avatar colors (Google-style pastel set).
const AVATAR_COLORS = [
  "#3367d6",
  "#0b8043",
  "#c5221f",
  "#8430ce",
  "#e37400",
  "#007b83",
  "#b80672",
  "#5f6368",
];

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a focused, secure document; fall back to the
    // legacy textarea trick (e.g. embedded/unfocused webviews).
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarInitial(text: string): string {
  return (text.trim()[0] || "?").toUpperCase();
}

/** Circular tinted icon container, Google-Docs-style. */
function IconCircle({
  tint,
  children,
}: {
  tint: "neutral" | "primary" | "success";
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={theme => ({
        width: 38,
        height: 38,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        bgcolor:
          tint === "primary"
            ? alpha(theme.palette.primary.main, 0.12)
            : tint === "success"
              ? alpha(theme.palette.success.main, 0.15)
              : theme.palette.action.selected,
        color:
          tint === "primary"
            ? theme.palette.primary.main
            : tint === "success"
              ? theme.palette.success.main
              : theme.palette.text.secondary,
      })}
    >
      {children}
    </Box>
  );
}

/** One row in the "People with access" list: avatar, name/email, role area. */
function PersonRow({
  primary,
  secondary,
  isYou,
  seed,
  action,
}: {
  primary: string;
  secondary?: string;
  isYou?: boolean;
  seed: string;
  action: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 1,
        py: 0.75,
        borderRadius: 1.5,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          fontSize: 14,
          fontWeight: 600,
          bgcolor: avatarColor(seed),
        }}
      >
        {avatarInitial(primary)}
      </Avatar>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
          {primary}
          {isYou && (
            <Typography component="span" variant="body2" color="text.secondary">
              {" (you)"}
            </Typography>
          )}
        </Typography>
        {secondary && (
          <Typography variant="caption" color="text.secondary" noWrap>
            {secondary}
          </Typography>
        )}
      </Box>
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}
      >
        {action}
      </Box>
    </Box>
  );
}

export default function ShareDialog({
  open,
  onClose,
  resourceType,
  resourceId,
  resourceName,
  ownerId,
  access: accessProp,
  workspaceRole: workspaceRoleProp,
  publicShare: publicShareProp,
  canManage = false,
  onSharingChanged,
}: ShareDialogProps) {
  const { user } = useAuth();
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const key = resourceId ? shareKey(resourceType, resourceId) : "";
  const collaborators = useShareStore(s =>
    key ? (s.collaborators[key] ?? NO_COLLABORATORS) : NO_COLLABORATORS,
  );
  const loadingCollaborators = useShareStore(s =>
    key ? !!s.loadingCollaborators[key] : false,
  );
  const loadCollaborators = useShareStore(s => s.loadCollaborators);
  const addCollaborator = useShareStore(s => s.addCollaborator);
  const updateCollaboratorRole = useShareStore(s => s.updateCollaboratorRole);
  const removeCollaborator = useShareStore(s => s.removeCollaborator);
  const updateSharingSettings = useShareStore(s => s.updateSharingSettings);
  const enablePublicShare = useShareStore(s => s.enablePublicShare);
  const updatePublicShare = useShareStore(s => s.updatePublicShare);
  const disablePublicShare = useShareStore(s => s.disablePublicShare);
  const getPublicSharePassword = useShareStore(s => s.getPublicSharePassword);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<ShareAccess>(accessProp ?? "private");
  const [workspaceRole, setWorkspaceRole] = useState<ShareRole>(
    workspaceRoleProp ?? "viewer",
  );
  const [publicShare, setPublicShare] = useState<PublicShareInfo>(
    publicShareProp ?? { enabled: false },
  );
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [internalCopied, setInternalCopied] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [requestedAppScope, setRequestedAppScope] =
    useState<AppLinkScope | null>(null);

  const supportsPublic = SUPPORTS_PUBLIC[resourceType];
  const label = RESOURCE_LABEL[resourceType];
  const currentAppScope: AppLinkScope | null = publicShare.enabled
    ? publicShare.hasPassword
      ? "public-password"
      : "public"
    : access === "workspace"
      ? "workspace"
      : null;
  const selectedAppScope = requestedAppScope ?? currentAppScope;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCopied(false);
    setInternalCopied(false);
    setPassword("");
    setRevealedPassword(null);
    setShowPassword(false);
    setEditingLink(false);
    setLinkDraft("");
    setRequestedAppScope(null);
    setAccess(accessProp ?? "private");
    setWorkspaceRole(workspaceRoleProp ?? "viewer");
    setPublicShare(publicShareProp ?? { enabled: false });
    void loadMembers();
    if (workspaceId && resourceId) {
      void loadCollaborators(resourceType, workspaceId, resourceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resourceId]);

  const emailByUserId = useMemo(
    () => new Map(members.map(m => [m.userId, m.email])),
    [members],
  );

  const sharedUserIds = useMemo(
    () => new Set(collaborators.map(c => c.userId)),
    [collaborators],
  );

  const addableMembers = useMemo(
    () =>
      members.filter(m => m.userId !== ownerId && !sharedUserIds.has(m.userId)),
    [members, ownerId, sharedUserIds],
  );

  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      setError(null);
      const result = await fn();
      setBusy(false);
      if (!result.ok) setError(result.error || "Something went wrong");
      return result.ok;
    },
    [],
  );

  const persistSettings = async (next: Partial<SharingSettings>) => {
    if (!workspaceId || !resourceId) return;
    await run(async () => {
      const result = await updateSharingSettings(
        resourceType,
        workspaceId,
        resourceId,
        next,
      );
      if (result.ok && result.settings) {
        setAccess(result.settings.access);
        setWorkspaceRole(result.settings.workspaceRole);
        onSharingChanged?.({
          access: result.settings.access,
          workspaceRole: result.settings.workspaceRole,
        });
      }
      return result;
    });
  };

  const handlePublicToggle = async (enabled: boolean) => {
    if (!workspaceId || !resourceId) return;
    if (enabled) {
      await run(async () => {
        const result = await enablePublicShare(
          resourceType,
          workspaceId,
          resourceId,
        );
        if (result.ok && result.publicShare) {
          setPublicShare(result.publicShare);
          onSharingChanged?.({ publicShare: result.publicShare });
        }
        return result;
      });
    } else {
      await run(async () => {
        const result = await disablePublicShare(
          resourceType,
          workspaceId,
          resourceId,
        );
        if (result.ok) {
          setPublicShare({ enabled: false });
          onSharingChanged?.({ publicShare: { enabled: false } });
        }
        return result;
      });
    }
  };

  const handleAppScopeChange = async (nextScope: AppLinkScope) => {
    if (!workspaceId || !resourceId) return;

    if (nextScope === "public-password" && !publicShare.hasPassword) {
      setRequestedAppScope(nextScope);
      setPassword("");
      return;
    }

    setRequestedAppScope(null);
    if (nextScope === "workspace") {
      await run(async () => {
        const settingsResult = await updateSharingSettings(
          resourceType,
          workspaceId,
          resourceId,
          { access: "workspace" },
        );
        if (!settingsResult.ok) return settingsResult;
        if (settingsResult.settings) {
          setAccess(settingsResult.settings.access);
          setWorkspaceRole(settingsResult.settings.workspaceRole);
          onSharingChanged?.({
            access: settingsResult.settings.access,
            workspaceRole: settingsResult.settings.workspaceRole,
          });
        }

        if (!publicShare.enabled) return { ok: true };
        const publicResult = await disablePublicShare(
          resourceType,
          workspaceId,
          resourceId,
        );
        if (publicResult.ok) {
          const disabledShare = { enabled: false } as const;
          setPublicShare(disabledShare);
          onSharingChanged?.({ publicShare: disabledShare });
        }
        return publicResult;
      });
      return;
    }

    await run(async () => {
      let nextPublicShare = publicShare;
      if (!nextPublicShare.enabled) {
        const enableResult = await enablePublicShare(
          resourceType,
          workspaceId,
          resourceId,
        );
        if (!enableResult.ok || !enableResult.publicShare) {
          return enableResult;
        }
        nextPublicShare = enableResult.publicShare;
      }

      if (nextScope === "public" && nextPublicShare.hasPassword) {
        const updateResult = await updatePublicShare(
          resourceType,
          workspaceId,
          resourceId,
          { password: null },
        );
        if (!updateResult.ok || !updateResult.publicShare) {
          return updateResult;
        }
        nextPublicShare = updateResult.publicShare;
      }

      setPublicShare(nextPublicShare);
      setRevealedPassword(null);
      setShowPassword(false);
      onSharingChanged?.({ publicShare: nextPublicShare });
      return { ok: true };
    });
  };

  const handleSetPassword = async () => {
    if (!workspaceId || !resourceId || !password) return;
    await run(async () => {
      const result = publicShare.enabled
        ? await updatePublicShare(resourceType, workspaceId, resourceId, {
            password,
          })
        : await enablePublicShare(
            resourceType,
            workspaceId,
            resourceId,
            password,
          );
      if (result.ok && result.publicShare) {
        setPublicShare(result.publicShare);
        setRevealedPassword(password);
        setPassword("");
        setRequestedAppScope(null);
        onSharingChanged?.({ publicShare: result.publicShare });
      }
      return result;
    });
  };

  const handleRemovePassword = async () => {
    if (!workspaceId || !resourceId) return;
    await run(async () => {
      const result = await updatePublicShare(
        resourceType,
        workspaceId,
        resourceId,
        { password: null },
      );
      if (result.ok && result.publicShare) {
        setPublicShare(result.publicShare);
        setRevealedPassword(null);
        setShowPassword(false);
        onSharingChanged?.({ publicShare: result.publicShare });
      }
      return result;
    });
  };

  // Apps only: a public viewer's "Refresh" re-runs the app's published
  // queries on the owner's connection (throttled per binding). Off by
  // default — a link stays a frozen snapshot until the owner says otherwise.
  const handleAllowLiveQueries = async (allow: boolean) => {
    if (!workspaceId || !resourceId) return;
    await run(async () => {
      const result = await updatePublicShare(
        resourceType,
        workspaceId,
        resourceId,
        { allowLiveQueries: allow },
      );
      if (result.ok && result.publicShare) {
        setPublicShare(result.publicShare);
        onSharingChanged?.({ publicShare: result.publicShare });
      }
      return result;
    });
  };

  const handleSaveLinkName = async () => {
    if (!workspaceId || !resourceId) return;
    const draft = linkDraft.trim();
    if (!draft || draft === publicShare.token) {
      setEditingLink(false);
      return;
    }
    const ok = await run(async () => {
      const result = await updatePublicShare(
        resourceType,
        workspaceId,
        resourceId,
        { token: draft },
      );
      if (result.ok && result.publicShare) {
        setPublicShare(result.publicShare);
        onSharingChanged?.({ publicShare: result.publicShare });
      }
      return result;
    });
    if (ok) setEditingLink(false);
  };

  const handleToggleReveal = async () => {
    if (showPassword) {
      setShowPassword(false);
      return;
    }
    if (revealedPassword !== null) {
      setShowPassword(true);
      return;
    }
    if (!workspaceId || !resourceId) return;
    const result = await getPublicSharePassword(
      resourceType,
      workspaceId,
      resourceId,
    );
    if (!result.ok) {
      setError(result.error || "Failed to retrieve password");
      return;
    }
    if (result.password == null) {
      setError(
        "This password can't be displayed — it was set before password reveal was supported. Set a new password to enable it.",
      );
      return;
    }
    setRevealedPassword(result.password);
    setShowPassword(true);
  };

  const handleRotateToken = async () => {
    if (!workspaceId || !resourceId) return;
    await run(async () => {
      const result = await updatePublicShare(
        resourceType,
        workspaceId,
        resourceId,
        { rotateToken: true },
      );
      if (result.ok && result.publicShare) {
        setPublicShare(result.publicShare);
        onSharingChanged?.({ publicShare: result.publicShare });
      }
      return result;
    });
  };

  const handleCopyLink = async () => {
    if (!publicShare.token) return;
    const url = buildPublicShareUrl(publicShare.token, currentWorkspace?.name);
    if (!(await copyTextToClipboard(url))) {
      setError("Failed to copy link");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The primary app link always opens the published app fullscreen. Public
  // scopes use the anonymous token; workspace-only uses the authenticated
  // deployment route (whose auth gate returns signed-out people after login).
  const handleCopyInternalLink = async () => {
    if (!resourceId) return;
    const url =
      resourceType === "app" && publicShare.enabled && publicShare.token
        ? buildPublicShareUrl(publicShare.token, currentWorkspace?.name)
        : buildWorkspaceResourceUrl(resourceType, resourceId, workspaceId);
    if (!(await copyTextToClipboard(url))) {
      setError("Failed to copy link");
      return;
    }
    setInternalCopied(true);
    setTimeout(() => setInternalCopied(false), 2000);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 7, fontSize: 18, fontWeight: 500 }}>
        Share {resourceName ? `"${resourceName}"` : `this ${label}`}
        <IconButton
          size="small"
          onClick={onClose}
          sx={{ position: "absolute", right: 14, top: 14 }}
        >
          <X size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {canManage && (
          <Box sx={{ mb: 2 }}>
            <Autocomplete
              options={addableMembers}
              getOptionLabel={option => option.email || option.userId}
              value={null}
              blurOnSelect
              clearOnBlur
              onChange={(_, value) => {
                if (value && workspaceId && resourceId) {
                  void run(() =>
                    addCollaborator(
                      resourceType,
                      workspaceId,
                      resourceId,
                      value.userId,
                      "editor",
                    ),
                  );
                }
              }}
              isOptionEqualToValue={(option, value) =>
                option.userId === value.userId
              }
              renderOption={(props, option) => (
                <Box
                  component="li"
                  {...props}
                  key={option.userId}
                  sx={{ display: "flex", gap: 1.5, alignItems: "center" }}
                >
                  <Avatar
                    sx={{
                      width: 28,
                      height: 28,
                      fontSize: 13,
                      fontWeight: 600,
                      bgcolor: avatarColor(option.userId),
                    }}
                  >
                    {avatarInitial(option.email || option.userId)}
                  </Avatar>
                  <Typography variant="body2">
                    {option.email || option.userId}
                  </Typography>
                </Box>
              )}
              renderInput={params => (
                <TextField
                  {...params}
                  placeholder="Add people by email"
                  size="small"
                />
              )}
              disabled={busy}
            />
          </Box>
        )}

        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          People with access
        </Typography>
        <Box sx={{ mb: 2, mx: -1 }}>
          <PersonRow
            primary={
              emailByUserId.get(ownerId || "") ||
              (ownerId === user?.id ? user?.email || "You" : ownerId || "Owner")
            }
            isYou={ownerId === user?.id}
            seed={ownerId || "owner"}
            action={
              <Typography variant="body2" color="text.secondary" sx={{ pr: 1 }}>
                Owner
              </Typography>
            }
          />

          {loadingCollaborators && collaborators.length === 0 && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
              <CircularProgress size={16} />
            </Box>
          )}

          {collaborators.map(collab => {
            const email =
              collab.email || emailByUserId.get(collab.userId) || collab.userId;
            return (
              <PersonRow
                key={collab.userId}
                primary={email}
                isYou={collab.userId === user?.id}
                seed={collab.userId}
                action={
                  canManage ? (
                    <>
                      <Select
                        size="small"
                        variant="standard"
                        disableUnderline
                        value={collab.role}
                        disabled={busy}
                        onChange={e => {
                          if (workspaceId && resourceId) {
                            void run(() =>
                              updateCollaboratorRole(
                                resourceType,
                                workspaceId,
                                resourceId,
                                collab.userId,
                                e.target.value as ShareRole,
                              ),
                            );
                          }
                        }}
                        sx={{
                          fontSize: 14,
                          color: "text.secondary",
                          "& .MuiSelect-select": { py: 0.25, pr: 3 },
                        }}
                      >
                        <MenuItem value="viewer">Viewer</MenuItem>
                        <MenuItem value="editor">Editor</MenuItem>
                      </Select>
                      <Tooltip title="Remove access">
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy}
                            onClick={() => {
                              if (workspaceId && resourceId) {
                                void run(() =>
                                  removeCollaborator(
                                    resourceType,
                                    workspaceId,
                                    resourceId,
                                    collab.userId,
                                  ),
                                );
                              }
                            }}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </>
                  ) : (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ pr: 1 }}
                    >
                      {collab.role === "viewer" ? "Viewer" : "Editor"}
                    </Typography>
                  )
                }
              />
            );
          })}
        </Box>

        {resourceType === "app" ? (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Link access
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <IconCircle
                tint={
                  selectedAppScope === "workspace"
                    ? "primary"
                    : selectedAppScope
                      ? "success"
                      : "neutral"
                }
              >
                {selectedAppScope === "workspace" ? (
                  <Building2 size={18} />
                ) : selectedAppScope === "public-password" ? (
                  <Lock size={18} />
                ) : selectedAppScope === "public" ? (
                  <Globe size={18} />
                ) : (
                  <Lock size={18} />
                )}
              </IconCircle>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {canManage ? (
                  <Select
                    size="small"
                    variant="standard"
                    disableUnderline
                    value={selectedAppScope ?? ""}
                    disabled={busy}
                    onChange={e =>
                      void handleAppScopeChange(e.target.value as AppLinkScope)
                    }
                    sx={{
                      fontSize: 14,
                      fontWeight: 500,
                      "& .MuiSelect-select": { py: 0, pr: 3 },
                    }}
                  >
                    {!selectedAppScope && (
                      <MenuItem value="" disabled>
                        Choose link access
                      </MenuItem>
                    )}
                    <MenuItem value="workspace">
                      Workspace members only
                    </MenuItem>
                    <MenuItem value="public-password">
                      Public with password
                    </MenuItem>
                    <MenuItem value="public">Public without password</MenuItem>
                  </Select>
                ) : (
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {!selectedAppScope
                      ? "Only invited people"
                      : selectedAppScope === "workspace"
                        ? "Workspace members only"
                        : selectedAppScope === "public-password"
                          ? "Public with password"
                          : "Public without password"}
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block" }}
                >
                  {!selectedAppScope
                    ? "Choose a sharing scope to create a fullscreen link for others"
                    : selectedAppScope === "workspace"
                      ? "Anyone in this workspace can open the fullscreen app after signing in"
                      : selectedAppScope === "public-password"
                        ? "Anyone with the link and password can open the fullscreen app"
                        : "Anyone with the link can open the fullscreen app"}
                </Typography>
              </Box>
            </Box>
            {requestedAppScope === "public-password" &&
              !publicShare.enabled &&
              canManage && (
                <TextField
                  size="small"
                  fullWidth
                  autoFocus
                  type="password"
                  placeholder="Choose a password"
                  value={password}
                  disabled={busy}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && password && !busy) {
                      e.preventDefault();
                      void handleSetPassword();
                    }
                  }}
                  sx={{ mt: 1, ml: 6.5, width: "calc(100% - 52px)" }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <Lock size={14} />
                      </InputAdornment>
                    ),
                    endAdornment: password ? (
                      <InputAdornment position="end">
                        <Button
                          size="small"
                          variant="contained"
                          disableElevation
                          disabled={busy}
                          onClick={() => void handleSetPassword()}
                        >
                          Protect link
                        </Button>
                      </InputAdornment>
                    ) : undefined,
                  }}
                />
              )}
          </>
        ) : (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              General access
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <IconCircle tint={access === "workspace" ? "primary" : "neutral"}>
                {access === "workspace" ? (
                  <Building2 size={18} />
                ) : (
                  <Lock size={18} />
                )}
              </IconCircle>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {canManage ? (
                  <Select
                    size="small"
                    variant="standard"
                    disableUnderline
                    value={access}
                    disabled={busy}
                    onChange={e =>
                      void persistSettings({
                        access: e.target.value as ShareAccess,
                      })
                    }
                    sx={{
                      fontSize: 14,
                      fontWeight: 500,
                      "& .MuiSelect-select": { py: 0, pr: 3 },
                    }}
                  >
                    <MenuItem value="private">Restricted</MenuItem>
                    <MenuItem value="workspace">Workspace</MenuItem>
                  </Select>
                ) : (
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {access === "private" ? "Restricted" : "Workspace"}
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block" }}
                >
                  {access === "private"
                    ? "Only people with access can open it"
                    : workspaceRole === "editor"
                      ? "Everyone in the workspace can edit"
                      : "Everyone in the workspace can view"}
                </Typography>
              </Box>
              {access === "workspace" && (
                <Select
                  size="small"
                  variant="standard"
                  disableUnderline
                  value={workspaceRole}
                  disabled={!canManage || busy}
                  onChange={e =>
                    void persistSettings({
                      workspaceRole: e.target.value as ShareRole,
                    })
                  }
                  sx={{
                    fontSize: 14,
                    color: "text.secondary",
                    "& .MuiSelect-select": { py: 0.25, pr: 3 },
                  }}
                >
                  <MenuItem value="viewer">Viewer</MenuItem>
                  <MenuItem value="editor">Editor</MenuItem>
                </Select>
              )}
            </Box>
          </>
        )}

        {supportsPublic && (
          <>
            {resourceType !== "app" && (
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 2 }}
              >
                <IconCircle tint={publicShare.enabled ? "success" : "neutral"}>
                  <Globe size={18} />
                </IconCircle>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    Public link
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block" }}
                  >
                    {publicShare.enabled
                      ? publicShare.hasPassword
                        ? "Anyone with the link and password can view a snapshot"
                        : "Anyone with the link can view a snapshot"
                      : "Off — not accessible outside the workspace"}
                  </Typography>
                </Box>
                <Switch
                  size="small"
                  checked={publicShare.enabled}
                  disabled={!canManage || busy}
                  onChange={e => void handlePublicToggle(e.target.checked)}
                />
              </Box>
            )}

            {publicShare.enabled && (
              <Box
                sx={{
                  ml: 6.5,
                  mt: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                }}
              >
                {editingLink ? (
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    value={linkDraft}
                    disabled={busy}
                    onChange={e => setLinkDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleSaveLinkName();
                      } else if (e.key === "Escape") {
                        setEditingLink(false);
                      }
                    }}
                    onBlur={() => void handleSaveLinkName()}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ maxWidth: 260 }}
                            noWrap
                          >
                            {publicShare.token
                              ? buildPublicShareUrl(
                                  publicShare.token,
                                  currentWorkspace?.name,
                                ).replace(/[^/]+$/, "")
                              : ""}
                          </Typography>
                        </InputAdornment>
                      ),
                    }}
                  />
                ) : (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.5,
                      minWidth: 0,
                      mx: -0.75,
                      "& .link-actions": { opacity: 0 },
                      "&:hover .link-actions": { opacity: 1 },
                    }}
                  >
                    <Tooltip
                      title={copied ? "Copied!" : "Click to copy link"}
                      placement="top"
                    >
                      <Box
                        onClick={() => void handleCopyLink()}
                        sx={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          minWidth: 0,
                          borderRadius: 1.5,
                          px: 0.75,
                          py: 0.25,
                          cursor: "pointer",
                          "&:hover": { bgcolor: "action.hover" },
                          "&:hover .share-url": {
                            textDecoration: "underline",
                          },
                        }}
                      >
                        {copied ? (
                          <Check size={14} style={{ flexShrink: 0 }} />
                        ) : (
                          <LinkIcon size={14} style={{ flexShrink: 0 }} />
                        )}
                        <Typography
                          className="share-url"
                          variant="caption"
                          noWrap
                          sx={{ flex: 1, color: "text.secondary" }}
                        >
                          {publicShare.token
                            ? buildPublicShareUrl(
                                publicShare.token,
                                currentWorkspace?.name,
                              )
                            : ""}
                        </Typography>
                      </Box>
                    </Tooltip>
                    {canManage && (
                      <Box
                        className="link-actions"
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          flexShrink: 0,
                          transition: "opacity 120ms",
                        }}
                      >
                        <Tooltip title="Edit link name">
                          <span>
                            <IconButton
                              size="small"
                              disabled={busy}
                              onClick={() => {
                                setLinkDraft(publicShare.token || "");
                                setEditingLink(true);
                              }}
                            >
                              <Pencil size={13} />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Generate a new link (old link stops working)">
                          <span>
                            <IconButton
                              size="small"
                              disabled={busy}
                              onClick={() => void handleRotateToken()}
                            >
                              <RefreshCw size={13} />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    )}
                  </Box>
                )}

                {canManage &&
                  (publicShare.hasPassword ? (
                    <Box
                      sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
                    >
                      <Lock size={13} />
                      {showPassword && revealedPassword !== null ? (
                        <Typography
                          variant="caption"
                          sx={{
                            fontFamily: "monospace",
                            bgcolor: "action.hover",
                            borderRadius: 0.75,
                            px: 0.75,
                            py: 0.25,
                          }}
                        >
                          {revealedPassword}
                        </Typography>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          Password protected
                        </Typography>
                      )}
                      <Tooltip
                        title={showPassword ? "Hide password" : "Show password"}
                      >
                        <IconButton
                          size="small"
                          onClick={() => void handleToggleReveal()}
                        >
                          {showPassword ? (
                            <EyeOff size={14} />
                          ) : (
                            <Eye size={14} />
                          )}
                        </IconButton>
                      </Tooltip>
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => void handleRemovePassword()}
                      >
                        Remove
                      </Button>
                    </Box>
                  ) : resourceType !== "app" ||
                    requestedAppScope === "public-password" ? (
                    <TextField
                      size="small"
                      fullWidth
                      type="password"
                      placeholder="Set a password (optional)"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && password && !busy) {
                          e.preventDefault();
                          void handleSetPassword();
                        }
                      }}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <Lock size={14} />
                          </InputAdornment>
                        ),
                        endAdornment: password ? (
                          <InputAdornment position="end">
                            <Button
                              size="small"
                              variant="contained"
                              disableElevation
                              disabled={busy}
                              onClick={() => void handleSetPassword()}
                              sx={{
                                minWidth: 0,
                                px: 1.5,
                                py: 0.25,
                                fontSize: 12,
                                borderRadius: 1,
                              }}
                            >
                              Set password
                            </Button>
                          </InputAdornment>
                        ) : undefined,
                      }}
                    />
                  ) : null)}

                {resourceType === "app" && canManage && (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      mt: 0.5,
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="caption" sx={{ display: "block" }}>
                        Let viewers refresh data
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: "block" }}
                      >
                        Re-runs the app&apos;s published queries on your
                        connection, at most every few minutes per binding
                      </Typography>
                    </Box>
                    <Switch
                      size="small"
                      checked={!!publicShare.allowLiveQueries}
                      disabled={busy}
                      onChange={e =>
                        void handleAllowLiveQueries(e.target.checked)
                      }
                    />
                  </Box>
                )}
              </Box>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5, justifyContent: "space-between" }}>
        <Tooltip
          title={
            resourceType === "app"
              ? requestedAppScope === "public-password"
                ? "Choose a password to create the protected link"
                : !currentAppScope
                  ? "Choose a sharing scope before copying the app link"
                  : publicShare.enabled
                    ? "Copy the public fullscreen app link"
                    : "Copy the fullscreen app link — workspace sign-in is required"
              : "Copy a link for people with access — they must be signed in to open it"
          }
        >
          <span>
            <Button
              variant="outlined"
              startIcon={
                internalCopied ? <Check size={16} /> : <LinkIcon size={16} />
              }
              disabled={
                !resourceId ||
                requestedAppScope !== null ||
                (resourceType === "app" && !currentAppScope)
              }
              onClick={() => void handleCopyInternalLink()}
            >
              {internalCopied
                ? "Copied"
                : resourceType === "app"
                  ? "Copy app link"
                  : "Copy link"}
            </Button>
          </span>
        </Tooltip>
        <Button variant="contained" disableElevation onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
