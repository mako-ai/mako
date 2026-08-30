/**
 * Settings > GitHub — the workspace's connected repositories.
 *
 * The primary object is the CONNECTED REPO (0..N per workspace, default 1):
 * apps (and later consoles, dbt projects) mount into them at
 * `<makoRoot>/apps/<app>`. GitHub App installations are plumbing — which
 * accounts repos can be picked from — shown as a secondary list with
 * manage/forget actions, never as the main event.
 *
 * "Add GitHub repository" is the single entry point. Clicking it silently
 * runs the user-authorization sync in a background tab (GitHub never fires
 * the install callback for an account where the app is already installed, so
 * this discovers + binds every installation the user controls — instant when
 * already authorized) and opens the connect dialog; a window-focus listener
 * refreshes the account list when the user returns from any GitHub hop.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ExternalLink, Github, Plus, Unplug } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import {
  useAppsStore,
  type AppGithubInstallation,
  type AppGithubRepo,
} from "../store/appsStore";

function installationSettingsUrl(inst: AppGithubInstallation): string {
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

  const repos = useAppsStore(s => s.repos);
  const fetchGithubStatus = useAppsStore(s => s.fetchGithubStatus);
  const fetchGithubRepos = useAppsStore(s => s.fetchGithubRepos);
  const getGitHubInstallUrl = useAppsStore(s => s.getGitHubInstallUrl);
  const getGitHubSyncUrl = useAppsStore(s => s.getGitHubSyncUrl);
  const connectRepo = useAppsStore(s => s.connectRepo);
  const disconnectRepo = useAppsStore(s => s.disconnectRepo);
  const disconnectGithubInstallation = useAppsStore(
    s => s.disconnectGithubInstallation,
  );

  const [installations, setInstallations] = useState<AppGithubInstallation[]>(
    [],
  );
  const [appSlug, setAppSlug] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [installationId, setInstallationId] = useState<number | "">("");
  const [pickerRepos, setPickerRepos] = useState<AppGithubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<AppGithubRepo | null>(null);
  const [makoRoot, setMakoRoot] = useState("/");
  const [reposLoading, setReposLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reloadStatus = useCallback(async () => {
    if (!workspaceId) return;
    const status = await fetchGithubStatus(workspaceId);
    setInstallations(status.installations);
    setAppSlug(status.appSlug);
    setInstallationId(current => {
      if (typeof current === "number") return current;
      return status.installations.length === 1
        ? status.installations[0].installationId
        : current;
    });
    setStatusLoading(false);
  }, [workspaceId, fetchGithubStatus]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  // Coming back from any GitHub hop (sync tab, install flow) → refresh the
  // accounts so the picker fills in without a manual reload.
  useEffect(() => {
    const onFocus = () => void reloadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadStatus]);

  useEffect(() => {
    if (typeof installationId !== "number" || !workspaceId) {
      setPickerRepos([]);
      return;
    }
    void (async () => {
      setReposLoading(true);
      setPickerRepos(await fetchGithubRepos(workspaceId, installationId));
      setReposLoading(false);
    })();
  }, [installationId, workspaceId, fetchGithubRepos]);

  const handleAdd = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setAddOpen(true);
    // Silent background sync: binds installations that already exist on
    // GitHub. Runs in a small popup that self-closes on completion (instant
    // when previously authorized); refocusing this window then triggers the
    // focus-refresh above. Sized like GitHub's own OAuth popups.
    const url = await getGitHubSyncUrl(workspaceId);
    if (url) window.open(url, "mako-github-sync", "width=640,height=760");
  }, [workspaceId, getGitHubSyncUrl]);

  const handleInstallNewAccount = useCallback(async () => {
    if (!workspaceId) return;
    const url = await getGitHubInstallUrl(workspaceId);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [workspaceId, getGitHubInstallUrl]);

  const handleConnect = useCallback(async () => {
    if (!workspaceId || !selectedRepo) return;
    setBusy(true);
    setError(null);
    const result = await connectRepo(workspaceId, {
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
      defaultBranch: selectedRepo.defaultBranch,
      // "/" (or blank) = repo root; the backend stores root as "".
      subdirectory: makoRoot.trim().replace(/^\/+$/, ""),
      installationId:
        typeof installationId === "number" ? installationId : undefined,
    });
    setBusy(false);
    if (result.ok) {
      setAddOpen(false);
      setSelectedRepo(null);
      // §13.17: connecting reconciles histories — say which way it went.
      setNotice(
        result.adoption === "imported"
          ? "Repository imported — its apps/ folders now appear as apps."
          : result.adoption === "seeded"
            ? "Repository connected — the workspace's existing apps were pushed into it."
            : result.adoption === "deferred"
              ? "Repository linked, but mirroring is INACTIVE in this environment — preview and dev deployments never push to customer repos. It engages in production."
              : "Repository connected — it is now where this workspace's apps are stored.",
      );
    } else {
      setError(result.error ?? "Failed to connect");
    }
  }, [workspaceId, selectedRepo, makoRoot, installationId, connectRepo]);

  const handleDisconnectRepo = useCallback(
    async (owner: string, repo: string) => {
      if (!workspaceId) return;
      if (
        !window.confirm(
          `Disconnect ${owner}/${repo}? Its content stays in GitHub; this workspace just stops pointing at it.`,
        )
      ) {
        return;
      }
      await disconnectRepo(workspaceId, owner, repo);
    },
    [workspaceId, disconnectRepo],
  );

  const handleForgetInstallation = useCallback(
    async (inst: AppGithubInstallation) => {
      if (!workspaceId) return;
      if (
        !window.confirm(
          `Forget the "${inst.accountLogin}" account? This only clears Mako's record — it does not uninstall the app on GitHub.`,
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
        setError(result.error ?? "Failed to forget account");
      }
    },
    [workspaceId, disconnectGithubInstallation, installationId, reloadStatus],
  );

  if (!isAdmin) {
    return (
      <Alert severity="info">
        Connecting GitHub requires the admin or owner workspace role.
      </Alert>
    );
  }

  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
          Workspace repository
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A workspace has exactly ONE repository — its content root. Apps live
          under <code>apps/</code>; consoles, skills and dbt content will join
          as sibling folders. Without a connected repo, the workspace is stored
          in Mako Cloud.
        </Typography>
        {repos.length > 1 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            This workspace has {repos.length} connected repositories from before
            the one-repo-per-workspace rule. Only the first is used — disconnect
            the others.
          </Alert>
        )}

        {repos.length === 0 && !statusLoading && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            No repository connected — apps are stored in Mako Cloud.
          </Typography>
        )}

        <Stack spacing={1}>
          {repos.map(repo => (
            <Box
              key={`${repo.owner}/${repo.repo}`}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                p: 1.5,
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
              }}
            >
              <AccountAvatar login={repo.owner} size={24} />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {repo.owner}/{repo.repo}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  branch {repo.defaultBranch} · Mako root{" "}
                  {repo.subdirectory || "/"} · apps under{" "}
                  {repo.subdirectory ? `${repo.subdirectory}/apps/` : "apps/"}
                </Typography>
              </Box>
              <Tooltip title="Open on GitHub">
                <IconButton
                  size="small"
                  component="a"
                  href={`https://github.com/${repo.owner}/${repo.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={16} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Disconnect from this workspace">
                <IconButton
                  size="small"
                  onClick={() =>
                    void handleDisconnectRepo(repo.owner, repo.repo)
                  }
                >
                  <Unplug size={16} />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Stack>

        {appSlug && repos.length === 0 && (
          <Button
            size="small"
            variant="contained"
            startIcon={<Plus size={14} />}
            onClick={() => void handleAdd()}
            sx={{ mt: 1.5 }}
          >
            Connect GitHub repository
          </Button>
        )}
      </Box>

      {installations.length > 0 && (
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
            GitHub accounts
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Accounts the Mako GitHub App is installed on — repositories are
            picked from these.
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {installations.map(inst => (
              <Box
                key={inst.installationId}
                sx={{ display: "flex", alignItems: "center", gap: 1 }}
              >
                <AccountAvatar login={inst.accountLogin} size={18} />
                <Typography variant="body2" sx={{ flex: 1 }}>
                  {inst.accountLogin}
                </Typography>
                <Tooltip title="Manage on GitHub (repo access, uninstall)">
                  <IconButton
                    size="small"
                    component="a"
                    href={installationSettingsUrl(inst)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Forget in Mako (does not uninstall on GitHub)">
                  <IconButton
                    size="small"
                    onClick={() => void handleForgetInstallation(inst)}
                    disabled={disconnectingId === inst.installationId}
                  >
                    <Unplug size={14} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Stack>
        </Box>
      )}

      {error && !addOpen && <Alert severity="error">{error}</Alert>}
      {notice && !addOpen && (
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add GitHub repository</DialogTitle>
        <DialogContent>
          <TextField
            select
            fullWidth
            margin="dense"
            label="GitHub account"
            value={installationId === "" ? "" : String(installationId)}
            onChange={e => {
              setInstallationId(Number(e.target.value));
              setSelectedRepo(null);
            }}
            helperText={
              installations.length === 0
                ? "Your accounts are syncing — this fills in when you return from GitHub."
                : undefined
            }
          >
            {installations.map(inst => (
              <MenuItem
                key={inst.installationId}
                value={String(inst.installationId)}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <AccountAvatar login={inst.accountLogin} />
                  {inst.accountLogin}
                </Box>
              </MenuItem>
            ))}
          </TextField>
          <Button
            size="small"
            onClick={() => void handleInstallNewAccount()}
            sx={{ mb: 1 }}
          >
            Install on another GitHub account…
          </Button>

          <Autocomplete
            options={pickerRepos}
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
            label="Mako root folder"
            helperText="The folder Mako owns in this repo (/ = repo root). Apps always go under its apps/ subfolder."
            value={makoRoot}
            onChange={e => setMakoRoot(e.target.value)}
          />

          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleConnect()}
            disabled={busy || !selectedRepo}
          >
            Connect
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
