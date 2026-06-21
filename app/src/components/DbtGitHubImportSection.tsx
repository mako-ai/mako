/**
 * GitHub repository picker for new dbt project import — searchable repos,
 * branch select, subdirectory with dbt_project.yml validation.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import { Check as CheckIcon, Github as GithubIcon } from "lucide-react";
import {
  useDbtStore,
  type GitHubRepoCheck,
  type GitHubRepoItem,
  type GitHubStatus,
} from "../store/dbtStore";

export interface GitHubImportSelection {
  owner: string;
  repo: string;
  branch: string;
  subdirectory?: string;
  installationId?: number;
  hasDbtProjectYml: boolean;
  ready: boolean;
}

interface DbtGitHubImportSectionProps {
  workspaceId: string;
  onSelectionChange: (selection: GitHubImportSelection | null) => void;
  onSuggestProjectName?: (name: string) => void;
}

function parseOwnerRepo(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw.trim().replace(/^https?:\/\/github\.com\//, "");
  const [owner, repo] = trimmed.split("/");
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

function subdirLabel(path: string): string {
  return path === "" ? "Repository root" : path;
}

export default function DbtGitHubImportSection({
  workspaceId,
  onSelectionChange,
  onSuggestProjectName,
}: DbtGitHubImportSectionProps) {
  const fetchGitHubStatus = useDbtStore(s => s.fetchGitHubStatus);
  const fetchGitHubRepos = useDbtStore(s => s.fetchGitHubRepos);
  const fetchGitHubBranches = useDbtStore(s => s.fetchGitHubBranches);
  const checkGitHubRepo = useDbtStore(s => s.checkGitHubRepo);
  const getGitHubInstallUrl = useDbtStore(s => s.getGitHubInstallUrl);

  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [ghStatusLoading, setGhStatusLoading] = useState(true);
  const [ghInstallationId, setGhInstallationId] = useState<number | "">("");
  const [ghRepos, setGhRepos] = useState<GitHubRepoItem[]>([]);
  const [ghReposLoading, setGhReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoItem | null>(null);
  const [manualRepo, setManualRepo] = useState("");
  const [showManualRepo, setShowManualRepo] = useState(false);
  const [ghBranch, setGhBranch] = useState("");
  const [ghSubdir, setGhSubdir] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [repoCheck, setRepoCheck] = useState<GitHubRepoCheck | null>(null);
  const [repoCheckLoading, setRepoCheckLoading] = useState(false);

  const resolvedRepo = useMemo(() => {
    if (selectedRepo) {
      return { owner: selectedRepo.owner, repo: selectedRepo.name };
    }
    return parseOwnerRepo(manualRepo);
  }, [selectedRepo, manualRepo]);

  const installationId = ghInstallationId === "" ? undefined : ghInstallationId;

  useEffect(() => {
    setGhStatusLoading(true);
    void fetchGitHubStatus(workspaceId)
      .then(status => setGhStatus(status))
      .finally(() => setGhStatusLoading(false));
  }, [workspaceId, fetchGitHubStatus]);

  useEffect(() => {
    if (!ghStatus || ghInstallationId !== "") return;
    if (ghStatus.installations.length > 0) {
      setGhInstallationId(ghStatus.installations[0].installationId);
    }
  }, [ghStatus, ghInstallationId]);

  useEffect(() => {
    if (ghInstallationId === "") {
      setGhRepos([]);
      return;
    }
    setGhReposLoading(true);
    void fetchGitHubRepos(workspaceId, ghInstallationId)
      .then(setGhRepos)
      .catch(() => setGhRepos([]))
      .finally(() => setGhReposLoading(false));
  }, [workspaceId, ghInstallationId, fetchGitHubRepos]);

  const handleRepoPick = useCallback(
    (repo: GitHubRepoItem | null) => {
      setSelectedRepo(repo);
      setManualRepo("");
      setShowManualRepo(false);
      if (repo) {
        setGhBranch(repo.defaultBranch);
        onSuggestProjectName?.(repo.name);
      } else {
        setGhBranch("");
        setBranches([]);
        setRepoCheck(null);
      }
    },
    [onSuggestProjectName],
  );

  const handleManualRepoChange = useCallback(
    (value: string) => {
      setManualRepo(value);
      setSelectedRepo(null);
      const parsed = parseOwnerRepo(value);
      if (parsed) {
        onSuggestProjectName?.(parsed.repo);
      }
    },
    [onSuggestProjectName],
  );

  useEffect(() => {
    if (!resolvedRepo) {
      setBranches([]);
      setRepoCheck(null);
      onSelectionChange(null);
      return;
    }

    let cancelled = false;
    setBranchesLoading(true);
    void fetchGitHubBranches(workspaceId, {
      owner: resolvedRepo.owner,
      repo: resolvedRepo.repo,
      installationId,
    })
      .then(list => {
        if (cancelled) return;
        setBranches(list);
        if (list.length > 0) {
          const preferred =
            selectedRepo?.defaultBranch &&
            list.includes(selectedRepo.defaultBranch)
              ? selectedRepo.defaultBranch
              : list[0];
          setGhBranch(prev => (prev && list.includes(prev) ? prev : preferred));
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    resolvedRepo,
    installationId,
    fetchGitHubBranches,
    selectedRepo,
    onSelectionChange,
  ]);

  useEffect(() => {
    if (!resolvedRepo || !ghBranch) {
      setRepoCheck(null);
      onSelectionChange(null);
      return;
    }

    let cancelled = false;
    setRepoCheckLoading(true);
    const subdir = ghSubdir.trim().replace(/^\/+|\/+$/g, "");

    void checkGitHubRepo(workspaceId, {
      owner: resolvedRepo.owner,
      repo: resolvedRepo.repo,
      branch: ghBranch,
      subdirectory: subdir || undefined,
      installationId,
    })
      .then(result => {
        if (cancelled) return;
        setRepoCheck(result);
        onSelectionChange({
          owner: resolvedRepo.owner,
          repo: resolvedRepo.repo,
          branch: ghBranch,
          subdirectory: subdir || undefined,
          installationId,
          hasDbtProjectYml: result?.hasDbtProjectYml ?? false,
          ready: Boolean(result),
        });
      })
      .finally(() => {
        if (!cancelled) setRepoCheckLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    resolvedRepo,
    ghBranch,
    ghSubdir,
    installationId,
    checkGitHubRepo,
    onSelectionChange,
  ]);

  const handleConnectGitHub = useCallback(async () => {
    const url = await getGitHubInstallUrl(workspaceId);
    if (url) window.open(url, "_blank", "noopener");
  }, [workspaceId, getGitHubInstallUrl]);

  const applySuggestedSubdir = useCallback((path: string) => {
    setGhSubdir(path);
  }, []);

  const hasInstallations = (ghStatus?.installations.length ?? 0) > 0;
  const showConnectCta =
    ghStatus?.appConfigured && !hasInstallations && !ghStatusLoading;

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1.5 }}>
        Git repository
      </Typography>

      {ghStatusLoading ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            Checking GitHub connection…
          </Typography>
        </Box>
      ) : showConnectCta ? (
        <Alert
          severity="info"
          icon={<GithubIcon size={18} strokeWidth={1.75} />}
          sx={{ mb: 1.5 }}
          action={
            <Button size="small" onClick={() => void handleConnectGitHub()}>
              Connect GitHub
            </Button>
          }
        >
          Connect a GitHub account to browse private repositories, or enter a
          public <code>owner/repo</code> below.
        </Alert>
      ) : null}

      {hasInstallations && (
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel id="dbt-create-gh-installation">
            GitHub account
          </InputLabel>
          <Select
            labelId="dbt-create-gh-installation"
            label="GitHub account"
            value={ghInstallationId === "" ? "" : String(ghInstallationId)}
            onChange={e => {
              const raw = String(e.target.value);
              setGhInstallationId(raw === "" ? "" : Number(raw));
              handleRepoPick(null);
            }}
          >
            {ghStatus?.installations.map(inst => (
              <MenuItem key={inst.installationId} value={inst.installationId}>
                {inst.accountLogin}
                {inst.accountType === "Organization" ? " (org)" : ""}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {hasInstallations && ghInstallationId !== "" && (
        <Autocomplete
          size="small"
          fullWidth
          loading={ghReposLoading}
          options={ghRepos}
          value={selectedRepo}
          onChange={(_, value) => handleRepoPick(value)}
          getOptionLabel={option => option.fullName}
          isOptionEqualToValue={(a, b) => a.fullName === b.fullName}
          noOptionsText={
            ghReposLoading ? "Loading repositories…" : "No repositories found"
          }
          renderInput={params => (
            <TextField
              {...params}
              label="Repository"
              placeholder="Search repositories…"
            />
          )}
          renderOption={(props, option) => {
            const { key, ...rest } = props;
            return (
              <Box component="li" key={key} {...rest}>
                <Typography variant="body2">{option.fullName}</Typography>
                {option.private && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 1 }}
                  >
                    private
                  </Typography>
                )}
              </Box>
            );
          }}
          sx={{ mb: 1 }}
        />
      )}

      {(hasInstallations || showManualRepo || !ghStatus?.appConfigured) && (
        <Box sx={{ mb: 1.5 }}>
          {hasInstallations && !showManualRepo && (
            <Link
              component="button"
              type="button"
              variant="caption"
              onClick={() => setShowManualRepo(true)}
            >
              Can&apos;t find your repository? Enter owner/repo manually
            </Link>
          )}
          <Collapse in={showManualRepo || !hasInstallations}>
            <TextField
              fullWidth
              size="small"
              label="Repository (owner/repo)"
              placeholder="dbt-labs/jaffle_shop"
              value={manualRepo}
              onChange={e => handleManualRepoChange(e.target.value)}
              sx={{ mt: hasInstallations ? 1 : 0 }}
            />
          </Collapse>
        </Box>
      )}

      {resolvedRepo && (
        <>
          <Box sx={{ display: "flex", gap: 1.5, mb: 1.5 }}>
            <FormControl
              size="small"
              sx={{ flex: 1 }}
              disabled={branchesLoading}
            >
              <InputLabel id="dbt-create-gh-branch">Branch</InputLabel>
              <Select
                labelId="dbt-create-gh-branch"
                label="Branch"
                value={branches.includes(ghBranch) ? ghBranch : ghBranch || ""}
                onChange={e => setGhBranch(e.target.value)}
              >
                {branchesLoading && (
                  <MenuItem disabled value="">
                    Loading branches…
                  </MenuItem>
                )}
                {branches.map(branch => (
                  <MenuItem key={branch} value={branch}>
                    {branch}
                  </MenuItem>
                ))}
                {ghBranch && !branches.includes(ghBranch) && (
                  <MenuItem value={ghBranch}>{ghBranch}</MenuItem>
                )}
              </Select>
            </FormControl>
            <TextField
              size="small"
              label="Subdirectory"
              placeholder="(repo root)"
              value={ghSubdir}
              onChange={e => setGhSubdir(e.target.value)}
              sx={{ flex: 1 }}
            />
          </Box>

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              flexWrap: "wrap",
              mb: 1,
            }}
          >
            {repoCheckLoading ? (
              <>
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  Checking for dbt_project.yml…
                </Typography>
              </>
            ) : repoCheck?.hasDbtProjectYml ? (
              <Chip
                size="small"
                color="success"
                variant="outlined"
                icon={<CheckIcon size={14} />}
                label="dbt_project.yml found"
              />
            ) : repoCheck ? (
              <Typography variant="caption" color="error">
                No dbt_project.yml at this path on branch {ghBranch}
              </Typography>
            ) : null}
          </Box>

          {repoCheck &&
            !repoCheck.hasDbtProjectYml &&
            repoCheck.suggestedSubdirectories.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                  sx={{ mb: 0.5 }}
                >
                  dbt projects found elsewhere in this repo:
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {repoCheck.suggestedSubdirectories.map(path => (
                    <Chip
                      key={path || "__root"}
                      size="small"
                      label={subdirLabel(path)}
                      onClick={() => applySuggestedSubdir(path)}
                      variant="outlined"
                    />
                  ))}
                </Box>
              </Box>
            )}
        </>
      )}

      {ghStatus?.appConfigured && (
        <Typography variant="caption" color="text.secondary">
          {hasInstallations ? "Need another account? " : ""}
          <Link
            component="button"
            type="button"
            variant="caption"
            onClick={() => void handleConnectGitHub()}
          >
            Connect a GitHub account
          </Link>
        </Typography>
      )}

      <Divider sx={{ mt: 2 }} />
    </Box>
  );
}
