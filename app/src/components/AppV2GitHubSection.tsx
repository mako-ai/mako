import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  useAppV2Store,
  type AppV2ConversationBranch,
  type AppV2Project,
} from "../store/appV2Store";

export default function AppV2GitHubSection({
  workspaceId,
  project,
  branches,
}: {
  workspaceId: string;
  project: AppV2Project;
  branches: AppV2ConversationBranch[];
}) {
  const fetchStatus = useAppV2Store(state => state.fetchGitHubStatus);
  const fetchRepos = useAppV2Store(state => state.fetchGitHubRepos);
  const fetchBranches = useAppV2Store(state => state.fetchGitHubBranches);
  const bind = useAppV2Store(state => state.bindGitHub);
  const unbind = useAppV2Store(state => state.unbindGitHub);
  const push = useAppV2Store(state => state.pushGitHubConversation);
  const loadingByKey = useAppV2Store(state => state.loadingByKey);
  const [installations, setInstallations] = useState<
    Array<{ installationId: number; accountLogin: string }>
  >([]);
  const [repos, setRepos] = useState<
    Array<{
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string;
    }>
  >([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [installationId, setInstallationId] = useState<number | "">(
    project.github?.installationId ?? "",
  );
  const [fullName, setFullName] = useState(
    project.github ? `${project.github.owner}/${project.github.repo}` : "",
  );
  const [baseBranch, setBaseBranch] = useState(
    project.github?.baseBranch ?? "",
  );
  const [subdirectory, setSubdirectory] = useState(
    project.github?.subdirectory ?? "",
  );
  const [autoPush, setAutoPush] = useState(
    project.github?.autoPushOnTurnEnd ?? false,
  );
  const error = useAppV2Store(state => {
    const exactKeys = new Set([
      `github-status:${workspaceId}`,
      `github-binding:${project.id}`,
      ...(installationId === "" ? [] : [`github-repos:${installationId}`]),
      ...(fullName ? [`github-branches:${fullName}`] : []),
    ]);
    return Array.from(
      new Set(
        Object.entries(state.errorsByKey)
          .filter(([key, value]) => {
            return (
              Boolean(value) &&
              (exactKeys.has(key) ||
                key.startsWith(`github-push:${project.id}:`))
            );
          })
          .map(([, value]) => value)
          .filter((value): value is string => Boolean(value)),
      ),
    ).join(" · ");
  });
  const canPush = !project.readOnly;
  const canManage = !project.readOnly && project.githubCanManage;
  const bindingLoading = Boolean(loadingByKey[`github-binding:${project.id}`]);
  const statusLoading = Boolean(loadingByKey[`github-status:${workspaceId}`]);
  const reposLoading =
    installationId === ""
      ? false
      : Boolean(loadingByKey[`github-repos:${installationId}`]);
  const branchesLoading = fullName
    ? Boolean(loadingByKey[`github-branches:${fullName}`])
    : false;

  useEffect(() => {
    if (!canManage) return;
    void fetchStatus(workspaceId).then(status => {
      const available = status?.installations ?? [];
      setInstallations(available);
      setInstallationId(current =>
        current === "" && available.length > 0
          ? available[0].installationId
          : current,
      );
    });
  }, [canManage, fetchStatus, workspaceId]);

  useEffect(() => {
    if (!canManage || installationId === "") return;
    void fetchRepos(workspaceId, installationId).then(setRepos);
  }, [canManage, fetchRepos, installationId, workspaceId]);

  const selectedRepo = useMemo(
    () => repos.find(repo => repo.fullName === fullName),
    [fullName, repos],
  );

  useEffect(() => {
    if (!canManage || installationId === "" || !selectedRepo) {
      setRemoteBranches([]);
      return;
    }
    void fetchBranches(workspaceId, {
      installationId,
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
    }).then(list => {
      setRemoteBranches(list);
      setBaseBranch(current =>
        current && list.includes(current)
          ? current
          : selectedRepo.defaultBranch,
      );
    });
  }, [canManage, fetchBranches, installationId, selectedRepo, workspaceId]);

  if (!project.githubPushAvailable) return null;

  const save = async () => {
    if (
      bindingLoading ||
      installationId === "" ||
      !selectedRepo ||
      !baseBranch
    ) {
      return;
    }
    await bind(workspaceId, project.id, {
      installationId,
      owner: selectedRepo.owner,
      repo: selectedRepo.name,
      baseBranch,
      subdirectory: subdirectory.trim() || undefined,
      autoPushOnTurnEnd: autoPush,
    });
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Typography variant="subtitle2" gutterBottom>
        GitHub mirror
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Mako Git remains authoritative. Conversation branches mirror to GitHub.
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}

      {canManage ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            gap: 1,
          }}
        >
          <FormControl size="small" disabled={statusLoading || bindingLoading}>
            <InputLabel id={`github-installation-${project.id}`}>
              Account
            </InputLabel>
            <Select
              labelId={`github-installation-${project.id}`}
              label="Account"
              value={
                installations.some(
                  installation =>
                    installation.installationId === installationId,
                )
                  ? installationId
                  : ""
              }
              onChange={event => {
                setInstallationId(Number(event.target.value));
                setFullName("");
              }}
            >
              {installations.map(installation => (
                <MenuItem
                  key={installation.installationId}
                  value={installation.installationId}
                >
                  {installation.accountLogin}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" disabled={reposLoading || bindingLoading}>
            <InputLabel id={`github-repo-${project.id}`}>Repository</InputLabel>
            <Select
              labelId={`github-repo-${project.id}`}
              label="Repository"
              value={
                repos.some(repo => repo.fullName === fullName) ? fullName : ""
              }
              onChange={event => {
                const value = String(event.target.value);
                setFullName(value);
                const repo = repos.find(
                  candidate => candidate.fullName === value,
                );
                setBaseBranch(repo?.defaultBranch ?? "");
              }}
            >
              {repos.map(repo => (
                <MenuItem key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl
            size="small"
            disabled={branchesLoading || bindingLoading}
          >
            <InputLabel id={`github-branch-${project.id}`}>
              Base branch
            </InputLabel>
            <Select
              labelId={`github-branch-${project.id}`}
              label="Base branch"
              value={remoteBranches.includes(baseBranch) ? baseBranch : ""}
              onChange={event => setBaseBranch(String(event.target.value))}
            >
              {remoteBranches.map(branch => (
                <MenuItem key={branch} value={branch}>
                  {branch}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Subdirectory"
            placeholder="Repository root"
            value={subdirectory}
            onChange={event => setSubdirectory(event.target.value)}
          />
          <FormControlLabel
            control={
              <Switch
                checked={autoPush}
                onChange={event => setAutoPush(event.target.checked)}
              />
            }
            label="Push automatically after each turn"
          />
          <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <Button
              variant="contained"
              disabled={
                bindingLoading ||
                statusLoading ||
                reposLoading ||
                branchesLoading ||
                installationId === "" ||
                !selectedRepo ||
                !baseBranch
              }
              onClick={() => void save()}
            >
              {project.github ? "Update binding" : "Connect"}
            </Button>
            {project.github ? (
              <Button
                color="warning"
                disabled={bindingLoading}
                onClick={() => void unbind(workspaceId, project.id)}
              >
                Unbind
              </Button>
            ) : null}
          </Box>
        </Box>
      ) : project.github ? (
        <Typography variant="body2">
          {project.github.owner}/{project.github.repo} ·{" "}
          {project.github.baseBranch}
        </Typography>
      ) : null}

      {project.github && branches.length > 0 ? (
        <Box
          sx={{ mt: 1.5, display: "flex", flexDirection: "column", gap: 0.75 }}
        >
          {branches.map(branch => (
            <Box
              key={branch.chatId}
              sx={{ display: "flex", alignItems: "center", gap: 1 }}
            >
              {branch.remote ? (
                <Link
                  href={`https://github.com/${project.github?.owner}/${project.github?.repo}/tree/${encodeURIComponent(branch.remote.branch)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                >
                  {branch.remote.branch}
                </Link>
              ) : (
                <Typography variant="body2">{branch.branch}</Typography>
              )}
              <Typography
                variant="caption"
                color={
                  branch.remote?.status === "conflict"
                    ? "error"
                    : "text.secondary"
                }
              >
                {branch.remote?.status ?? "local only"}
              </Typography>
              {canPush && branch.lastCommitSha ? (
                <Button
                  size="small"
                  disabled={Boolean(
                    loadingByKey[`github-push:${project.id}:${branch.chatId}`],
                  )}
                  onClick={() =>
                    void push(workspaceId, project.id, branch.chatId)
                  }
                >
                  Push
                </Button>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
    </Paper>
  );
}
