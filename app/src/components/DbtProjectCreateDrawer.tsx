/**
 * New dbt project drawer — blank project or GitHub import (replaces centered modal).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import {
  Github as GithubIcon,
  Plus as PlusIcon,
  X as CloseIcon,
} from "lucide-react";
import { DEFAULT_DBT_VERSION } from "../lib/dbt-versions";
import { focusDbtFileTab } from "../dbt-runtime/shell";
import { useExplorerStore } from "../store/explorerStore";
import { useDbtStore } from "../store/dbtStore";
import type { Connection } from "../store/schemaStore";
import DbtGitHubImportSection, {
  type GitHubImportSelection,
} from "./DbtGitHubImportSection";
import DbtVersionSelect from "./DbtVersionSelect";

const DRAWER_WIDTH = 540;

interface DbtProjectCreateDrawerProps {
  open: boolean;
  mode: "blank" | "github";
  workspaceId: string;
  connections: Connection[];
  onClose: () => void;
}

export default function DbtProjectCreateDrawer({
  open,
  mode: initialMode,
  workspaceId,
  connections,
  onClose,
}: DbtProjectCreateDrawerProps) {
  const createProject = useDbtStore(s => s.createProject);
  const importProjectFromGitHub = useDbtStore(s => s.importProjectFromGitHub);
  const fetchFiles = useDbtStore(s => s.fetchFiles);
  const fetchJobs = useDbtStore(s => s.fetchJobs);
  const expandDbtFolder = useExplorerStore(s => s.expandDbtFolder);

  const [createMode, setCreateMode] = useState<"blank" | "github">("blank");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [dbtVersion, setDbtVersion] = useState(DEFAULT_DBT_VERSION);
  const [connectionId, setConnectionId] = useState("");
  const [devSchema, setDevSchema] = useState("dbt_dev");
  const [prodSchema, setProdSchema] = useState("dbt_prod");
  const [creating, setCreating] = useState(false);
  const [ghSelection, setGhSelection] = useState<GitHubImportSelection | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setCreateMode("blank");
    setName("");
    setNameTouched(false);
    setDbtVersion(DEFAULT_DBT_VERSION);
    setConnectionId(connections[0]?.id ?? "");
    setDevSchema("dbt_dev");
    setProdSchema("dbt_prod");
    setGhSelection(null);
    setError(null);
  }, [connections]);

  useEffect(() => {
    if (!open) return;
    resetForm();
    setCreateMode(initialMode);
  }, [open, initialMode, resetForm]);

  useEffect(() => {
    if (open && connectionId === "" && connections[0]?.id) {
      setConnectionId(connections[0].id);
    }
  }, [open, connectionId, connections]);

  const environments = useMemo(
    () => [
      {
        name: "dev",
        connectionId,
        targetSchema: devSchema.trim() || "dbt_dev",
        threads: 4,
      },
      {
        name: "prod",
        connectionId,
        targetSchema: prodSchema.trim() || "dbt_prod",
        threads: 4,
      },
    ],
    [connectionId, devSchema, prodSchema],
  );

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const afterCreated = useCallback(
    async (projectId: string) => {
      await Promise.all([
        fetchFiles(workspaceId, projectId),
        fetchJobs(workspaceId, projectId),
      ]);
      expandDbtFolder(projectId);
      focusDbtFileTab(projectId, "dbt_project.yml");
      handleClose();
    },
    [workspaceId, fetchFiles, fetchJobs, expandDbtFolder, handleClose],
  );

  const handleSuggestProjectName = useCallback(
    (suggested: string) => {
      if (!nameTouched && suggested) {
        setName(suggested);
      }
    },
    [nameTouched],
  );

  const handleCreateBlank = useCallback(async () => {
    if (!name.trim() || !connectionId) return;
    setCreating(true);
    setError(null);
    const created = await createProject(workspaceId, {
      name: name.trim(),
      dbtVersion,
      environments,
      defaultEnvironment: "dev",
    });
    setCreating(false);
    if (created) {
      await afterCreated(created._id);
    } else {
      setError(
        useDbtStore.getState().error.projects ?? "Failed to create project",
      );
    }
  }, [
    workspaceId,
    name,
    connectionId,
    dbtVersion,
    environments,
    createProject,
    afterCreated,
  ]);

  const handleImportGitHub = useCallback(async () => {
    if (!name.trim() || !connectionId || !ghSelection?.ready) return;
    if (!ghSelection.hasDbtProjectYml) {
      setError("dbt_project.yml not found — fix the subdirectory or branch");
      return;
    }
    setCreating(true);
    setError(null);
    const created = await importProjectFromGitHub(workspaceId, {
      name: name.trim(),
      dbtVersion,
      environments,
      defaultEnvironment: "dev",
      repo: {
        owner: ghSelection.owner,
        repo: ghSelection.repo,
        branch: ghSelection.branch,
        subdirectory: ghSelection.subdirectory,
        installationId: ghSelection.installationId,
      },
    });
    setCreating(false);
    if (created) {
      await afterCreated(created._id);
    } else {
      setError(useDbtStore.getState().error.projects ?? "Import failed");
    }
  }, [
    workspaceId,
    name,
    connectionId,
    dbtVersion,
    environments,
    ghSelection,
    importProjectFromGitHub,
    afterCreated,
  ]);

  const canSubmitBlank = name.trim() && connectionId;
  const canSubmitGitHub =
    canSubmitBlank &&
    ghSelection?.ready &&
    ghSelection.hasDbtProjectYml &&
    !creating;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleClose}
      sx={{ zIndex: theme => theme.zIndex.modal }}
      PaperProps={{
        sx: {
          width: { xs: "100%", sm: DRAWER_WIDTH },
          maxWidth: "100vw",
          display: "flex",
          flexDirection: "column",
          boxShadow: theme => theme.shadows[16],
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <PlusIcon size={18} strokeWidth={1.75} />
          <Typography variant="subtitle1" fontWeight={600}>
            New dbt project
          </Typography>
        </Box>
        <IconButton size="small" aria-label="Close" onClick={handleClose}>
          <CloseIcon size={18} />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 2 }}>
        <ToggleButtonGroup
          value={createMode}
          exclusive
          size="small"
          fullWidth
          onChange={(_, value) => {
            if (value) setCreateMode(value);
          }}
          sx={{ mb: 2 }}
        >
          <ToggleButton value="blank">Blank project</ToggleButton>
          <ToggleButton value="github">
            <GithubIcon
              size={15}
              strokeWidth={1.75}
              style={{ marginRight: 6 }}
            />
            Import from GitHub
          </ToggleButton>
        </ToggleButtonGroup>

        {createMode === "github" && (
          <DbtGitHubImportSection
            workspaceId={workspaceId}
            onSelectionChange={setGhSelection}
            onSuggestProjectName={handleSuggestProjectName}
          />
        )}

        <TextField
          autoFocus={createMode === "blank"}
          fullWidth
          size="small"
          label="Project name"
          value={name}
          onChange={e => {
            setNameTouched(true);
            setName(e.target.value);
          }}
          sx={{ mb: 2 }}
        />

        <Box sx={{ mb: 2 }}>
          <DbtVersionSelect value={dbtVersion} onChange={setDbtVersion} />
        </Box>

        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1.5 }}>
          Environments
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          display="block"
          sx={{ mb: 1.5 }}
        >
          Creates a <strong>dev</strong> and <strong>prod</strong> environment.
          Add more later in project settings.
        </Typography>

        <FormControl fullWidth size="small" sx={{ mb: 2 }}>
          <InputLabel id="dbt-create-connection">Connection</InputLabel>
          <Select
            labelId="dbt-create-connection"
            label="Connection"
            value={connectionId}
            onChange={e => setConnectionId(e.target.value)}
          >
            {connections.map(conn => (
              <MenuItem key={conn.id} value={conn.id}>
                {conn.name} ({conn.type})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {connections.length === 0 && (
          <Typography
            variant="caption"
            color="error"
            display="block"
            sx={{ mb: 2 }}
          >
            Add a Postgres, BigQuery, ClickHouse, MySQL, Redshift or SQL Server
            connection in Databases first.
          </Typography>
        )}
        <TextField
          fullWidth
          size="small"
          label="Dev target schema"
          value={devSchema}
          onChange={e => setDevSchema(e.target.value)}
          sx={{ mb: 1.5 }}
        />
        <TextField
          fullWidth
          size="small"
          label="Prod target schema"
          value={prodSchema}
          onChange={e => setProdSchema(e.target.value)}
        />

        {error && (
          <Typography
            variant="caption"
            color="error"
            sx={{ mt: 2, display: "block" }}
          >
            {error}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 1,
          px: 2,
          py: 1.5,
          borderTop: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Button size="small" onClick={handleClose} disabled={creating}>
          Cancel
        </Button>
        {createMode === "github" ? (
          <Button
            size="small"
            onClick={() => void handleImportGitHub()}
            startIcon={
              creating ? (
                <CircularProgress size={14} />
              ) : (
                <GithubIcon size={15} strokeWidth={1.75} />
              )
            }
            disabled={!canSubmitGitHub}
          >
            {creating ? "Importing…" : "Import project"}
          </Button>
        ) : (
          <Button
            size="small"
            onClick={() => void handleCreateBlank()}
            disabled={creating || !canSubmitBlank}
          >
            {creating ? "Creating…" : "Create project"}
          </Button>
        )}
      </Box>
    </Drawer>
  );
}
