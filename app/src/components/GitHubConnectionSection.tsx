/**
 * Settings > GitHub — the workspace's GitHub App connection.
 *
 * Shows every installation bound to this workspace (account, type, a link to
 * manage/uninstall it on github.com), a way to connect another account, and
 * (today) the Apps v2 repo binding — Apps v2 apps live as subdirectories of
 * one linked repo. dbt has its own separate repo-import flow; this section
 * only owns the shared "which GitHub accounts are connected" concern plus
 * Apps v2's repo pick, not dbt's project import.
 *
 * Previously this was a modal opened from the Apps v2 explorer
 * (AppsV2LinkRepoDialog). Moved here so a broken/stale installation (GitHub
 * only allows one live installation per account, so an uninstall+reinstall
 * cycle can leave a dead binding behind in whichever workspace-scoped
 * database missed the uninstall webhook) has a real place to see and fix it,
 * instead of silently failing inside a feature-panel dialog.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ExternalLink, Github, RefreshCw, Unplug } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import {
  useAppsV2Store,
  type AppV2GithubInstallation,
  type AppV2GithubRepo,
} from "../store/appsV2Store";

function installationSettingsUrl(inst: AppV2GithubInstallation): string {
  const base =
    inst.accountType === "Organization"
      ? `https://github.com/organizations/${inst.accountLogin}/settings/installations`
      : "https://github.com/settings/installations";
  return `${base}/${inst.installationId}`;
}

/** Public GitHub avatar for an org/user login (no auth needed). */
function AccountAvatar({ login, size = 18 }: { login: string; size?: number }) {
  return (
    <Avatar
      src={`https://github.com/${login}.png?size=${size * 2}`}
      alt={login}
      sx={{ width: size, height: size }}
    >
      <Github size={size - 6} />
    </Avatar>
  );
}

export default function GitHubConnectionSection() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const isAdmin = useIsWorkspaceAdmin();

  const linkedRepo = useAppsV2Store(s => s.linkedRepo);
  const fetchGithubStatus = useAppsV2Store(s => s.fetchGithubStatus);
  const fetchGithubRepos = useAppsV2Store(s => s.fetchGithubRepos);
  const getGitHubInstallUrl = useAppsV2Store(s => s.getGitHubInstallUrl);
  const linkRepo = useAppsV2Store(s => s.linkRepo);
  const unlinkRepo = useAppsV2Store(s => s.unlinkRepo);
  const disconnectGithubInstallation = useAppsV2Store(
    s => s.disconnectGithubInstallation,
  );

  const [installations, setInstallations] = useState<AppV2GithubInstallation[]>(
    [],
  );
  const [appSlug, setAppSlug] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [installationId, setInstallationId] = useState<number | "">("");
  const [repos, setRepos] = useState<AppV2GithubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<AppV2GithubRepo | null>(
    null,
  );
  const [subdirectory, setSubdirectory] = useState("apps");
  const [reposLoading, setReposLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadStatus = useCallback(async () => {
    if (!workspaceId) return;
    setStatusLoading(true);
    const status = await fetchGithubStatus(workspaceId);
    setInstallations(status.installations);
    setAppSlug(status.appSlug);
    if (status.installations.length === 1) {
      setInstallationId(status.installations[0].installationId);
    }
    setStatusLoading(false);
  }, [workspaceId, fetchGithubStatus]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    if (typeof installationId !== "number" || !workspaceId) {
      setRepos([]);
      return;
    }
    void (async () => {
      setReposLoading(true);
      setRepos(await fetchGithubRepos(workspaceId, installationId));
      setReposLoading(false);
    })();
  }, [installationId, workspaceId, fetchGithubRepos]);

  const handleConnect = useCallback(async () => {
    if (!workspaceId) return;
    setConnecting(true);
    const url = await getGitHubInstallUrl(workspaceId);
    setConnecting(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [workspaceId, getGitHubInstallUrl]);

  const handleDisconnect = useCallback(
    async (inst: AppV2GithubInstallation) => {
      if (!workspaceId) return;
      if (
        !window.confirm(
          `Forget the "${inst.accountLogin}" installation? This only clears Mako's local record — it does not uninstall the app on GitHub. Use this to clear a broken/stale entry after reinstalling on github.com.`,
        )
      ) {
        return;
      }
      setDisconnectingId(inst.installationId);
      const result = await disconnectGithubInstallation(
        workspaceId,
        inst.installationId,
      );
      setDisconnectingId(null);
      if (result.ok) {
        if (installationId === inst.installationId) setInstallationId("");
        void reloadStatus();
      } else {
        setError(result.error ?? "Failed to disconnect");
      }
    },
    [workspaceId, disconnectGithubInstallation, installationId, reloadStatus],
  );

  const handleLink = useCallback(async () => {
    if (!workspaceId || !selectedRepo) return;
    setLinking(true);
    setError(null);
    const result = await linkRepo(workspaceId, {
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
      defaultBranch: selectedRepo.defaultBranch,
      subdirectory: subdirectory.trim() || "apps",
      installationId:
        typeof installationId === "number" ? installationId : undefined,
    });
    setLinking(false);
    if (!result.ok) setError(result.error ?? "Failed to link");
  }, [workspaceId, selectedRepo, subdirectory, installationId, linkRepo]);

  const handleUnlink = useCallback(async () => {
    if (!workspaceId) return;
    if (
      !window.confirm(
        "Unlink this repo? Existing apps stay in GitHub; this workspace just stops pointing at them.",
      )
    ) {
      return;
    }
    await unlinkRepo(workspaceId);
  }, [workspaceId, unlinkRepo]);

  if (!isAdmin) {
    return (
      <Alert severity="info">
        Connecting GitHub requires the admin or owner workspace role.
      </Alert>
    );
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
          Installations
        </Typography>
        {statusLoading ? (
          <Typography variant="body2" color="text.secondary">
            Loading…
          </Typography>
        ) : installations.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No GitHub App installation is connected to this workspace yet.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {installations.map(inst => (
              <Box
                key={inst.installationId}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  p: 1.5,
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                }}
              >
                <AccountAvatar login={inst.accountLogin} size={24} />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {inst.accountLogin}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {inst.accountType ?? "account"} · installation{" "}
                    {inst.installationId}
                  </Typography>
                </Box>
                <Tooltip title="Manage on GitHub (uninstall, change repo access)">
                  <IconButton
                    size="small"
                    component="a"
                    href={installationSettingsUrl(inst)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={16} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Forget this installation in Mako (does not uninstall on GitHub)">
                  <IconButton
                    size="small"
                    onClick={() => void handleDisconnect(inst)}
                    disabled={disconnectingId === inst.installationId}
                  >
                    <Unplug size={16} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Stack>
        )}
        {appSlug && (
          <Button
            size="small"
            startIcon={<RefreshCw size={14} />}
            onClick={() => void handleConnect()}
            disabled={connecting}
            sx={{ mt: 1.5 }}
          >
            Connect another account
          </Button>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
          Apps v2 repository
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Apps v2 apps live as subfolders of one linked repo, e.g.
          apps/my-dashboard/.
        </Typography>

        {linkedRepo && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Linked to{" "}
            <strong>
              {linkedRepo.owner}/{linkedRepo.repo}
            </strong>{" "}
            (default branch <code>{linkedRepo.defaultBranch}</code>, apps under{" "}
            <code>{linkedRepo.subdirectory}/</code>).
          </Alert>
        )}

        {installations.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Connect a GitHub account above first.
          </Typography>
        ) : (
          <>
            <TextField
              select
              fullWidth
              margin="dense"
              label="GitHub account / installation"
              value={installationId === "" ? "" : String(installationId)}
              onChange={e => {
                setInstallationId(Number(e.target.value));
                setSelectedRepo(null);
              }}
            >
              {installations.map(inst => (
                <MenuItem
                  key={inst.installationId}
                  value={String(inst.installationId)}
                >
                  {/* Select renders the chosen MenuItem's children in the
                      closed state too, so the avatar shows there as well. */}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <AccountAvatar login={inst.accountLogin} />
                    {inst.accountLogin}
                  </Box>
                </MenuItem>
              ))}
            </TextField>

            <Autocomplete
              options={repos}
              loading={reposLoading}
              getOptionLabel={r => r.fullName}
              value={selectedRepo}
              onChange={(_, v) => setSelectedRepo(v)}
              disabled={typeof installationId !== "number"}
              renderOption={(props, option) => (
                <Box
                  component="li"
                  {...props}
                  key={option.fullName}
                  sx={{ display: "flex", gap: 1 }}
                >
                  <Github size={14} style={{ flexShrink: 0 }} />
                  {option.fullName}
                </Box>
              )}
              renderInput={params => (
                <TextField
                  {...params}
                  margin="dense"
                  label="Repository"
                  placeholder="Search repositories..."
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: selectedRepo ? (
                      <Github size={14} style={{ marginLeft: 6 }} />
                    ) : undefined,
                  }}
                />
              )}
            />

            <TextField
              fullWidth
              margin="dense"
              label="Apps folder"
              helperText="Apps are created as subfolders here, e.g. apps/my-dashboard/"
              value={subdirectory}
              onChange={e => setSubdirectory(e.target.value)}
            />

            {error && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {error}
              </Alert>
            )}

            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button
                variant="contained"
                onClick={() => void handleLink()}
                disabled={linking || !selectedRepo}
              >
                {linkedRepo ? "Change repo" : "Link"}
              </Button>
              {linkedRepo && (
                <Button color="error" onClick={() => void handleUnlink()}>
                  Unlink
                </Button>
              )}
            </Stack>
          </>
        )}
      </Box>
    </Stack>
  );
}
