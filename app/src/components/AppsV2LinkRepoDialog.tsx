/**
 * Apps v2 — link (or manage) the workspace's GitHub apps repo.
 *
 * Reuses the shared GitHub App integration (installations + repo listing).
 * Admins pick an installation and one of its repos; that repo becomes the
 * durable store for the workspace's Apps v2 apps (folders in the repo).
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import {
  useAppsV2Store,
  type AppV2GithubInstallation,
  type AppV2GithubRepo,
} from "../store/appsV2Store";

export default function AppsV2LinkRepoDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const linkedRepo = useAppsV2Store(s => s.linkedRepo);
  const fetchGithubStatus = useAppsV2Store(s => s.fetchGithubStatus);
  const fetchGithubRepos = useAppsV2Store(s => s.fetchGithubRepos);
  const getGitHubInstallUrl = useAppsV2Store(s => s.getGitHubInstallUrl);
  const linkRepo = useAppsV2Store(s => s.linkRepo);
  const unlinkRepo = useAppsV2Store(s => s.unlinkRepo);

  const [installations, setInstallations] = useState<AppV2GithubInstallation[]>(
    [],
  );
  const [appSlug, setAppSlug] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<number | "">("");
  const [repos, setRepos] = useState<AppV2GithubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<AppV2GithubRepo | null>(
    null,
  );
  const [subdirectory, setSubdirectory] = useState("apps");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void (async () => {
      const status = await fetchGithubStatus(workspaceId);
      setInstallations(status.installations);
      setAppSlug(status.appSlug);
      if (status.installations.length === 1) {
        setInstallationId(status.installations[0].installationId);
      }
    })();
  }, [open, workspaceId, fetchGithubStatus]);

  useEffect(() => {
    if (typeof installationId !== "number") {
      setRepos([]);
      return;
    }
    void (async () => {
      setLoading(true);
      setRepos(await fetchGithubRepos(workspaceId, installationId));
      setLoading(false);
    })();
  }, [installationId, workspaceId, fetchGithubRepos]);

  const handleLink = useCallback(async () => {
    if (!selectedRepo) return;
    setLoading(true);
    setError(null);
    const result = await linkRepo(workspaceId, {
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
      defaultBranch: selectedRepo.defaultBranch,
      subdirectory: subdirectory.trim() || "apps",
      installationId:
        typeof installationId === "number" ? installationId : undefined,
    });
    setLoading(false);
    if (result.ok) onClose();
    else setError(result.error ?? "Failed to link");
  }, [
    selectedRepo,
    subdirectory,
    installationId,
    workspaceId,
    linkRepo,
    onClose,
  ]);

  const handleInstall = useCallback(async () => {
    setLoading(true);
    const url = await getGitHubInstallUrl(workspaceId);
    setLoading(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [workspaceId, getGitHubInstallUrl]);

  const handleUnlink = useCallback(async () => {
    if (
      !window.confirm(
        "Unlink this repo? Existing apps stay in GitHub; this workspace just stops pointing at them.",
      )
    ) {
      return;
    }
    setLoading(true);
    await unlinkRepo(workspaceId);
    setLoading(false);
    onClose();
  }, [workspaceId, unlinkRepo, onClose]);

  const noInstallations = installations.length === 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {linkedRepo ? "Apps v2 GitHub repo" : "Link a GitHub repo"}
      </DialogTitle>
      <DialogContent>
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

        {noInstallations ? (
          <Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              No GitHub App installation is connected to this workspace yet.
              Install the Mako GitHub App on the org/repo you want to use for
              apps, then reopen this dialog.
            </Typography>
            {appSlug && (
              <Button
                variant="outlined"
                size="small"
                onClick={() => void handleInstall()}
                disabled={loading}
                sx={{ mt: 1 }}
              >
                Install the Mako GitHub App
              </Button>
            )}
          </Box>
        ) : (
          <>
            <TextField
              select
              fullWidth
              margin="normal"
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
                  {inst.accountLogin}
                </MenuItem>
              ))}
            </TextField>

            {appSlug && (
              <Typography variant="caption" color="text.secondary">
                Account missing, or &quot;Repository&quot; failing to load for
                an existing one?{" "}
                <Button
                  size="small"
                  onClick={() => void handleInstall()}
                  disabled={loading}
                  sx={{ p: 0, minWidth: 0, verticalAlign: "baseline" }}
                >
                  Reinstall the Mako GitHub App
                </Button>{" "}
                to refresh it.
              </Typography>
            )}

            <Autocomplete
              options={repos}
              loading={loading}
              getOptionLabel={r => r.fullName}
              value={selectedRepo}
              onChange={(_, v) => setSelectedRepo(v)}
              disabled={typeof installationId !== "number"}
              renderInput={params => (
                <TextField
                  {...params}
                  margin="normal"
                  label="Repository"
                  placeholder="Search repositories..."
                />
              )}
            />

            <TextField
              fullWidth
              margin="normal"
              label="Apps folder"
              helperText="Apps are created as subfolders here, e.g. apps/my-dashboard/"
              value={subdirectory}
              onChange={e => setSubdirectory(e.target.value)}
            />
          </>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {linkedRepo && (
          <Button
            color="error"
            onClick={() => void handleUnlink()}
            disabled={loading}
          >
            Unlink
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={loading}>
          Close
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleLink()}
          disabled={loading || !selectedRepo}
        >
          {linkedRepo ? "Change repo" : "Link"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
