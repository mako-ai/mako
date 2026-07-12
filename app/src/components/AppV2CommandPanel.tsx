import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import { useAppV2Store } from "../store/appV2Store";
import {
  buildAppV2CommandArgv,
  parseAppV2PackageList,
} from "../apps-v2-runtime/command";

export default function AppV2CommandPanel({
  workspaceId,
  projectId,
  readOnly,
}: {
  workspaceId: string;
  projectId: string;
  readOnly: boolean;
}) {
  const availability = useAppV2Store(
    state => state.availabilityByWorkspace[workspaceId],
  );
  const session = useAppV2Store(state => state.sessionsByProject[projectId]);
  const command = useAppV2Store(
    state => state.sessionCommandsByProject[projectId],
  );
  const flush = useAppV2Store(
    state => state.sessionFlushesByProject[projectId],
  );
  const issue = useAppV2Store(state => state.sessionIssuesByProject[projectId]);
  const busy = useAppV2Store(state =>
    Object.entries(state.loadingByKey).some(
      ([key, loading]) => loading && key.includes(projectId),
    ),
  );
  const fetchStatus = useAppV2Store(state => state.fetchStatusWithRetry);
  const getSession = useAppV2Store(state => state.getSession);
  const ensureSession = useAppV2Store(state => state.ensureSession);
  const execSession = useAppV2Store(state => state.execSession);
  const installPackages = useAppV2Store(state => state.installPackages);
  const flushSession = useAppV2Store(state => state.flushSession);
  const pauseSession = useAppV2Store(state => state.pauseSession);
  const destroySession = useAppV2Store(state => state.destroySession);
  const [executable, setExecutable] = useState("pnpm");
  const [argumentLines, setArgumentLines] = useState("run\ntypecheck");
  const [packageLines, setPackageLines] = useState("");
  const [commandError, setCommandError] = useState<string | null>(null);
  const packageList = useMemo(
    () => parseAppV2PackageList(packageLines),
    [packageLines],
  );

  useEffect(() => {
    void fetchStatus(workspaceId);
  }, [fetchStatus, workspaceId]);

  useEffect(() => {
    if (availability?.sandboxAvailable) {
      void getSession(workspaceId, projectId);
    }
  }, [availability?.sandboxAvailable, getSession, projectId, workspaceId]);

  const runCommand = useCallback(async () => {
    try {
      const argv = buildAppV2CommandArgv(executable, argumentLines);
      setCommandError(null);
      await execSession(workspaceId, projectId, argv);
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "Invalid command",
      );
    }
  }, [argumentLines, execSession, executable, projectId, workspaceId]);

  const install = useCallback(async () => {
    if (packageList.error) return;
    await installPackages(workspaceId, projectId, packageList.packages);
  }, [installPackages, packageList, projectId, workspaceId]);

  if (!availability?.sandboxAvailable) {
    return (
      <Alert severity="info">
        Isolated execution is not provisioned for Apps v2. Preview and terminal
        access will appear only after a sandbox runtime is available.
      </Alert>
    );
  }

  const canRun =
    !readOnly &&
    !busy &&
    (session?.status === "active" || session?.status === "paused");
  const durability = command?.durability ?? flush?.durability;
  const excludedPaths = command?.excludedPaths ?? flush?.excludedPaths ?? [];

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="subtitle2">Isolated command session</Typography>
        <Chip
          size="small"
          label={session?.status ?? "Not started"}
          color={session?.status === "active" ? "success" : "default"}
        />
        <Chip size="small" label={availability.sandboxProvider} />
      </Box>
      <Typography variant="body2" color="text.secondary">
        Commands run in an isolated sandbox. Eligible source changes are flushed
        to your Git-backed worktree after every finite operation.
      </Typography>

      {issue ? (
        <Alert
          severity={issue.kind === "provider_unavailable" ? "error" : "warning"}
        >
          {issue.message}
          {issue.recoveryRef ? ` Recovery ref: ${issue.recoveryRef}` : ""}
          {issue.retryable
            ? " Retry after the current operation finishes."
            : ""}
        </Alert>
      ) : null}

      {!session || session.status === "destroyed" ? (
        <Button
          variant="contained"
          onClick={() => void ensureSession(workspaceId, projectId)}
          disabled={readOnly || busy}
        >
          Start session
        </Button>
      ) : (
        <>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "minmax(180px, 1fr) 2fr" },
              gap: 1,
            }}
          >
            <TextField
              label="Executable"
              value={executable}
              onChange={event => setExecutable(event.target.value)}
              disabled={!canRun}
              error={Boolean(commandError)}
              helperText={commandError ?? "One executable; no shell parsing"}
            />
            <TextField
              label="Arguments"
              value={argumentLines}
              onChange={event => setArgumentLines(event.target.value)}
              disabled={!canRun}
              multiline
              minRows={2}
              helperText="One argument per line; shell syntax stays literal"
            />
          </Box>
          <Button
            variant="contained"
            onClick={() => void runCommand()}
            disabled={!canRun}
          >
            Run command
          </Button>

          <TextField
            label="Packages"
            value={packageLines}
            onChange={event => setPackageLines(event.target.value)}
            disabled={!canRun}
            multiline
            minRows={2}
            error={Boolean(packageLines && packageList.error)}
            helperText={
              packageLines && packageList.error
                ? packageList.error
                : "One npm registry package spec per line"
            }
          />
          <Button
            onClick={() => void install()}
            disabled={!canRun || Boolean(packageList.error)}
          >
            Install packages
          </Button>

          {command ? (
            <Box aria-label="Last command result">
              <Typography variant="body2">
                Exit code: {command.exitCode ?? "none"}
                {command.timedOut ? " (timed out)" : ""}
                {command.cancelled ? " (cancelled)" : ""}
                {command.outputTruncated ? " (output truncated)" : ""}
              </Typography>
              <Typography component="pre" variant="body2" sx={{ m: 0 }}>
                {command.stdout || "(no stdout)"}
              </Typography>
              <Typography
                component="pre"
                variant="body2"
                color="error"
                sx={{ m: 0 }}
              >
                {command.stderr || "(no stderr)"}
              </Typography>
            </Box>
          ) : null}

          {durability ? (
            <Typography variant="body2">
              Durability: {durability.status}
              {durability.status === "conflict"
                ? ` (${durability.recoveryRef})`
                : ` (revision ${durability.revision.revision})`}
            </Typography>
          ) : null}
          {excludedPaths.length ? (
            <Typography variant="body2" color="text.secondary">
              Excluded from Git: {excludedPaths.join(", ")}
            </Typography>
          ) : null}

          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              onClick={() => void flushSession(workspaceId, projectId)}
              disabled={!canRun}
            >
              Flush source
            </Button>
            <Button
              onClick={() => void pauseSession(workspaceId, projectId)}
              disabled={!canRun}
            >
              Pause
            </Button>
            <Button
              color="error"
              onClick={() => void destroySession(workspaceId, projectId)}
              disabled={readOnly || busy}
            >
              Destroy
            </Button>
          </Box>
        </>
      )}
    </Paper>
  );
}
