/**
 * DbtProjectSettingsDrawer — project + environment settings (dbt Cloud-style
 * drawer, not a centered modal). View-first; Edit enables full CRUD including
 * add/remove environments.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import {
  ArrowLeft as BackIcon,
  ChevronRight as ChevronIcon,
  ExternalLink as ExternalLinkIcon,
  Lock as LockIcon,
  Pencil as EditIcon,
  Plus as PlusIcon,
  Settings as SettingsIcon,
  Trash2 as TrashIcon,
  X as CloseIcon,
} from "lucide-react";
import { useAuth } from "../contexts/auth-context";
import {
  useDbtStore,
  visibleDbtEnvironments,
  type DbtEnvironment,
  type DbtProjectItem,
} from "../store/dbtStore";
import type { Connection } from "../store/schemaStore";
import { dbtVersionLabel, normalizeDbtVersion } from "../lib/dbt-versions";
import { resolveDevEnvName, resolveProdLikeEnvName } from "../lib/dbt-env";
import DbtVersionSelect from "./DbtVersionSelect";

const DRAWER_WIDTH = 540;

function connectionLabel(
  connectionId: string,
  connections: Connection[],
): string {
  const conn = connections.find(c => c.id === connectionId);
  if (!conn) return "Unknown connection";
  return `${conn.name} (${conn.type})`;
}

function envBadge(envName: string, project: DbtProjectItem): string {
  if (
    envName === project.defaultEnvironment ||
    envName === "dev" ||
    envName === "development"
  ) {
    return "DEV";
  }
  if (
    envName === resolveProdLikeEnvName(project) ||
    envName === "prod" ||
    envName === "production"
  ) {
    return "PROD";
  }
  return "General";
}

function formatSha(sha?: string): string {
  if (!sha) return "—";
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

function defaultNewEnvironment(
  existing: DbtEnvironment[],
  connections: Connection[],
): DbtEnvironment {
  const n = existing.length + 1;
  const baseConn = existing[0]?.connectionId ?? connections[0]?.id ?? "";
  return {
    name: n === 2 ? "prod" : `env_${n}`,
    connectionId: baseConn,
    targetSchema: n === 2 ? "dbt_prod" : `dbt_env_${n}`,
    threads: 4,
  };
}

function SettingsSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        mb: 2,
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.25,
          bgcolor: "action.hover",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="subtitle2" fontWeight={600}>
          {title}
        </Typography>
        {action}
      </Box>
      <Box sx={{ px: 2, py: 1.5 }}>{children}</Box>
    </Box>
  );
}

function ReadOnlyField({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      {href ? (
        <Link
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          variant="body2"
        >
          {value}
        </Link>
      ) : (
        <Typography variant="body2">{value}</Typography>
      )}
    </Box>
  );
}

interface DbtProjectSettingsDrawerProps {
  open: boolean;
  projectId: string | null;
  workspaceId: string;
  connections: Connection[];
  onClose: () => void;
}

export default function DbtProjectSettingsDrawer({
  open,
  projectId,
  workspaceId,
  connections,
  onClose,
}: DbtProjectSettingsDrawerProps) {
  const { user } = useAuth();
  const projects = useDbtStore(s => s.projects);
  const updateProject = useDbtStore(s => s.updateProject);
  const listBranches = useDbtStore(s => s.listBranches);
  const ensurePersonalEnvironment = useDbtStore(
    s => s.ensurePersonalEnvironment,
  );
  const setMyEnvironment = useDbtStore(s => s.setMyEnvironment);
  const [creatingPersonalEnv, setCreatingPersonalEnv] = useState(false);

  const project = useMemo(
    () => projects.find(p => p._id === projectId) ?? null,
    [projects, projectId],
  );

  const [selectedEnvName, setSelectedEnvName] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [editName, setEditName] = useState("");
  const [editDbtVersion, setEditDbtVersion] = useState("");
  const [editDefaultEnv, setEditDefaultEnv] = useState("");
  // Production/defer environment override; "" = Auto (env named "prod",
  // else the project default).
  const [editProdEnv, setEditProdEnv] = useState("");
  const [editEnvs, setEditEnvs] = useState<DbtEnvironment[]>([]);
  // Branch protection (repo-bound projects): edits apply immediately (each
  // add/remove PATCHes the project) — independent of the drawer's Edit mode.
  const [newProtectedBranch, setNewProtectedBranch] = useState("");
  const [savingProtection, setSavingProtection] = useState(false);
  // Tracked branch (what deploy/job runs build): applies immediately, like
  // branch protection. Remote branches populate the picker.
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [savingTrackedBranch, setSavingTrackedBranch] = useState(false);
  const [trackedBranchError, setTrackedBranchError] = useState<string | null>(
    null,
  );
  // Per-environment variable rows, parallel to editEnvs (same index). Kept as
  // an ordered array (not a record) so typing keys never reorders or collides.
  const [editVarRows, setEditVarRows] = useState<
    Array<Array<{ key: string; value: string }>>
  >([]);

  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envModalDraft, setEnvModalDraft] = useState<DbtEnvironment | null>(
    null,
  );
  const [envModalVarRows, setEnvModalVarRows] = useState<
    Array<{ key: string; value: string }>
  >([]);
  const [envModalSaving, setEnvModalSaving] = useState(false);
  const [envModalError, setEnvModalError] = useState<string | null>(null);

  const resetFromProject = useCallback((p: DbtProjectItem) => {
    setEditName(p.name);
    setEditDbtVersion(normalizeDbtVersion(p.dbtVersion));
    setEditDefaultEnv(p.defaultEnvironment);
    setEditProdEnv(p.prodEnvironment ?? "");
    setEditEnvs(p.environments.map(env => ({ ...env })));
    setEditVarRows(
      p.environments.map(env =>
        Object.entries(env.vars ?? {}).map(([key, value]) => ({
          key,
          value: typeof value === "string" ? value : JSON.stringify(value),
        })),
      ),
    );
    setSaveError(null);
  }, []);

  useEffect(() => {
    if (!open || !projectId) return;
    setSelectedEnvName(null);
    setIsEditing(false);
    setSaveError(null);
  }, [open, projectId]);

  useEffect(() => {
    if (!open || !project) return;
    if (!isEditing) resetFromProject(project);
  }, [open, project, isEditing, resetFromProject]);

  const handleClose = useCallback(() => {
    setIsEditing(false);
    setSelectedEnvName(null);
    setSaveError(null);
    onClose();
  }, [onClose]);

  const handleCancelEdit = useCallback(() => {
    if (project) resetFromProject(project);
    setIsEditing(false);
    setSaveError(null);
  }, [project, resetFromProject]);

  const isRepoBound = project?.repo != null;

  useEffect(() => {
    if (!open || !projectId || !isRepoBound) return;
    setTrackedBranchError(null);
    void listBranches(workspaceId, projectId).then(result => {
      if (result) setRemoteBranches(result.branches);
    });
  }, [open, projectId, workspaceId, isRepoBound, listBranches]);

  const handleTrackedBranchChange = useCallback(
    async (branch: string) => {
      if (!project || !projectId || branch === project.repo?.branch) return;
      setSavingTrackedBranch(true);
      setTrackedBranchError(null);
      const updated = await updateProject(workspaceId, projectId, {
        repoBranch: branch,
      });
      if (!updated) {
        setTrackedBranchError(
          useDbtStore.getState().error.projects ?? "Failed to update branch",
        );
      }
      setSavingTrackedBranch(false);
    },
    [project, projectId, workspaceId, updateProject],
  );

  const selectedEnv = useMemo(() => {
    if (!selectedEnvName) return null;
    if (isEditing) {
      const fromEdit = editEnvs.find(e => e.name === selectedEnvName);
      if (fromEdit) return fromEdit;
    }
    return project?.environments.find(e => e.name === selectedEnvName) ?? null;
  }, [project, selectedEnvName, isEditing, editEnvs]);
  const selectedEnvIndex = useMemo(
    () =>
      selectedEnvName
        ? editEnvs.findIndex(e => e.name === selectedEnvName)
        : -1,
    [editEnvs, selectedEnvName],
  );

  const updateEditEnv = useCallback(
    (index: number, patch: Partial<DbtEnvironment>) => {
      setEditEnvs(prev =>
        prev.map((env, i) => (i === index ? { ...env, ...patch } : env)),
      );
    },
    [],
  );

  const closeEnvModal = useCallback(() => {
    if (envModalSaving) return;
    setEnvModalOpen(false);
    setEnvModalDraft(null);
    setEnvModalVarRows([]);
    setEnvModalError(null);
  }, [envModalSaving]);

  const openCreateEnvModal = useCallback(() => {
    const existing = isEditing ? editEnvs : (project?.environments ?? []);
    const draft = defaultNewEnvironment(existing, connections);
    setEnvModalDraft(draft);
    setEnvModalVarRows([]);
    setEnvModalError(null);
    setEnvModalOpen(true);
  }, [isEditing, editEnvs, project?.environments, connections]);

  const validateEnvironmentDraft = useCallback(
    (
      draft: DbtEnvironment,
      varRows: Array<{ key: string; value: string }>,
      existingNames: string[],
    ): { env: DbtEnvironment; error: string | null } => {
      const name = draft.name.trim();
      if (!name) return { env: draft, error: "Environment name is required." };
      if (existingNames.some(n => n.trim() === name)) {
        return { env: draft, error: "Environment names must be unique." };
      }
      if (!draft.connectionId) {
        return { env: draft, error: "Connection is required." };
      }
      if (!draft.targetSchema.trim()) {
        return { env: draft, error: "Target schema is required." };
      }
      if (connections.length === 0) {
        return {
          env: draft,
          error: "Add a database connection before saving environments.",
        };
      }
      const vars: Record<string, string> = {};
      for (const row of varRows) {
        const key = row.key.trim();
        if (key) vars[key] = row.value;
      }
      return {
        env: {
          ...draft,
          name,
          targetSchema: draft.targetSchema.trim(),
          threads: Number(draft.threads) || 1,
          vars,
        },
        error: null,
      };
    },
    [connections.length],
  );

  const handleEnvModalSave = useCallback(async () => {
    if (!envModalDraft || !workspaceId || !projectId) return;
    const existingNames = isEditing
      ? editEnvs.map(e => e.name)
      : (project?.environments.map(e => e.name) ?? []);
    const { env: normalized, error } = validateEnvironmentDraft(
      envModalDraft,
      envModalVarRows,
      existingNames,
    );
    if (error) {
      setEnvModalError(error);
      return;
    }
    if (normalized.ownerUserId) {
      const existingEnvs = isEditing ? editEnvs : (project?.environments ?? []);
      const owned = existingEnvs.find(
        e => e.ownerUserId === normalized.ownerUserId,
      );
      if (owned) {
        setEnvModalError(
          `You already own the personal environment "${owned.name}" — each user can own only one per project.`,
        );
        return;
      }
    }

    if (isEditing) {
      setEditEnvs(prev => [...prev, normalized]);
      setEditVarRows(prev => [...prev, envModalVarRows]);
      if (!editDefaultEnv && editEnvs.length === 0) {
        setEditDefaultEnv(normalized.name);
      }
      closeEnvModal();
      return;
    }

    if (!project) return;
    setEnvModalSaving(true);
    setEnvModalError(null);
    const updated = await updateProject(workspaceId, projectId, {
      environments: [...project.environments, normalized],
    });
    setEnvModalSaving(false);
    if (updated) {
      resetFromProject(updated);
      closeEnvModal();
    } else {
      setEnvModalError(
        "Failed to save environment. Check your connection settings.",
      );
    }
  }, [
    envModalDraft,
    envModalVarRows,
    workspaceId,
    projectId,
    isEditing,
    editEnvs,
    editDefaultEnv,
    validateEnvironmentDraft,
    closeEnvModal,
    project,
    updateProject,
    resetFromProject,
  ]);

  const handleRemoveEnvironment = useCallback(
    (index: number) => {
      if (editEnvs.length <= 1) return;
      const removed = editEnvs[index];
      const next = editEnvs.filter((_, i) => i !== index);
      setEditEnvs(next);
      setEditVarRows(prev => prev.filter((_, i) => i !== index));
      if (editDefaultEnv === removed.name) {
        setEditDefaultEnv(next[0]?.name ?? "");
      }
      if (selectedEnvName === removed.name) {
        setSelectedEnvName(null);
      }
    },
    [editEnvs, editDefaultEnv, selectedEnvName],
  );

  const addVarRow = useCallback((envIndex: number) => {
    setEditVarRows(prev =>
      prev.map((rows, i) =>
        i === envIndex ? [...rows, { key: "", value: "" }] : rows,
      ),
    );
  }, []);

  const updateVarRow = useCallback(
    (
      envIndex: number,
      rowIndex: number,
      patch: Partial<{ key: string; value: string }>,
    ) => {
      setEditVarRows(prev =>
        prev.map((rows, i) =>
          i === envIndex
            ? rows.map((row, r) =>
                r === rowIndex ? { ...row, ...patch } : row,
              )
            : rows,
        ),
      );
    },
    [],
  );

  const removeVarRow = useCallback((envIndex: number, rowIndex: number) => {
    setEditVarRows(prev =>
      prev.map((rows, i) =>
        i === envIndex ? rows.filter((_, r) => r !== rowIndex) : rows,
      ),
    );
  }, []);

  const validateBeforeSave = useCallback((): string | null => {
    if (!editName.trim()) return "Project name is required.";
    const names = editEnvs.map(e => e.name.trim());
    if (names.some(n => !n)) return "Every environment needs a name.";
    const unique = new Set(names);
    if (unique.size !== names.length) {
      return "Environment names must be unique.";
    }
    if (!editEnvs.some(e => e.name.trim() === editDefaultEnv)) {
      return "Default environment must match one of the environment names.";
    }
    if (editProdEnv && !editEnvs.some(e => e.name.trim() === editProdEnv)) {
      return "Production environment must match one of the environment names.";
    }
    // Personal (owned) environments are per-user build targets: at most one
    // per user, and never the shared default / production environment.
    const ownedNames = new Map<string, string>();
    for (const env of editEnvs) {
      if (!env.ownerUserId) continue;
      const prior = ownedNames.get(env.ownerUserId);
      if (prior) {
        return `"${prior}" and "${env.name.trim()}" are personal environments of the same user — each user can own only one.`;
      }
      ownedNames.set(env.ownerUserId, env.name.trim());
    }
    if (editEnvs.find(e => e.name.trim() === editDefaultEnv)?.ownerUserId) {
      return "The default environment cannot be a personal environment.";
    }
    if (
      editProdEnv &&
      editEnvs.find(e => e.name.trim() === editProdEnv)?.ownerUserId
    ) {
      return "The production environment cannot be a personal environment.";
    }
    for (const env of editEnvs) {
      if (!env.connectionId) return `Connection is required for "${env.name}".`;
      if (!env.targetSchema.trim()) {
        return `Target schema is required for "${env.name}".`;
      }
    }
    if (connections.length === 0) {
      return "Add a database connection before saving environments.";
    }
    return null;
  }, [editName, editEnvs, editDefaultEnv, editProdEnv, connections.length]);

  const handleSave = useCallback(async () => {
    if (!workspaceId || !projectId) return;
    const validationError = validateBeforeSave();
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const normalizedEnvs = editEnvs.map((env, index) => {
      const vars: Record<string, string> = {};
      for (const row of editVarRows[index] ?? []) {
        const key = row.key.trim();
        if (key) vars[key] = row.value;
      }
      return {
        ...env,
        name: env.name.trim(),
        targetSchema: env.targetSchema.trim(),
        threads: Number(env.threads) || 1,
        vars,
      };
    });
    const updated = await updateProject(workspaceId, projectId, {
      name: editName.trim(),
      environments: normalizedEnvs,
      defaultEnvironment: editDefaultEnv,
      // "" clears the override back to Auto (prod by name, else default).
      prodEnvironment: editProdEnv,
      dbtVersion: editDbtVersion,
    });
    setSaving(false);
    if (updated) {
      resetFromProject(updated);
      setIsEditing(false);
      if (
        selectedEnvName &&
        !updated.environments.some(e => e.name === selectedEnvName)
      ) {
        setSelectedEnvName(null);
      }
    } else {
      setSaveError("Failed to save project. Check your connection settings.");
    }
  }, [
    workspaceId,
    projectId,
    validateBeforeSave,
    editEnvs,
    editVarRows,
    editName,
    editDefaultEnv,
    editProdEnv,
    editDbtVersion,
    updateProject,
    resetFromProject,
    selectedEnvName,
  ]);

  const setProtectedBranches = useCallback(
    async (branches: string[]) => {
      if (!workspaceId || !projectId) return;
      setSavingProtection(true);
      await updateProject(workspaceId, projectId, {
        protectedBranches: branches,
      });
      setSavingProtection(false);
    },
    [workspaceId, projectId, updateProject],
  );

  const handleAddProtectedBranch = useCallback(() => {
    if (!project) return;
    const branch = newProtectedBranch.trim();
    if (!branch) return;
    const current = project.protectedBranches ?? [];
    if (current.includes(branch)) {
      setNewProtectedBranch("");
      return;
    }
    setNewProtectedBranch("");
    void setProtectedBranches([...current, branch]);
  }, [project, newProtectedBranch, setProtectedBranches]);

  const devConnectionName = project
    ? connectionLabel(
        project.environments.find(e => e.name === project.defaultEnvironment)
          ?.connectionId ??
          project.environments[0]?.connectionId ??
          "",
        connections,
      )
    : "—";

  const repoUrl = project?.repo
    ? `https://github.com/${project.repo.owner}/${project.repo.repo}`
    : undefined;

  const headerTitle = selectedEnvName ? selectedEnvName : "Project settings";

  const showOverviewEditButton =
    Boolean(project) && !isEditing && !selectedEnvName;

  const renderEnvironmentEditor = (index: number, compact?: boolean) => {
    const env = editEnvs[index];
    if (!env) return null;
    return (
      <Box
        key={index}
        sx={{
          mb: compact ? 0 : 2,
          p: compact ? 0 : 1.5,
          border: compact ? 0 : 1,
          borderColor: "divider",
          borderRadius: 1,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 1.5,
          }}
        >
          <Typography variant="subtitle2" fontWeight={600}>
            {compact ? "Environment" : env.name || "New environment"}
          </Typography>
          {editEnvs.length > 1 && (
            <IconButton
              size="small"
              aria-label="Remove environment"
              onClick={() => handleRemoveEnvironment(index)}
            >
              <TrashIcon size={16} />
            </IconButton>
          )}
        </Box>
        <TextField
          fullWidth
          size="small"
          label="Environment name"
          value={env.name}
          onChange={e => {
            const nextName = e.target.value;
            const prevName = env.name;
            updateEditEnv(index, { name: nextName });
            if (editDefaultEnv === prevName) setEditDefaultEnv(nextName);
            if (selectedEnvName === prevName) setSelectedEnvName(nextName);
          }}
          sx={{ mb: 1.5 }}
        />
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel id={`dbt-settings-conn-${index}`}>Connection</InputLabel>
          <Select
            labelId={`dbt-settings-conn-${index}`}
            label="Connection"
            value={env.connectionId}
            onChange={e =>
              updateEditEnv(index, { connectionId: e.target.value })
            }
          >
            {connections.map(conn => (
              <MenuItem key={conn.id} value={conn.id}>
                {conn.name} ({conn.type})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          fullWidth
          size="small"
          label="Target schema"
          value={env.targetSchema}
          onChange={e => updateEditEnv(index, { targetSchema: e.target.value })}
          sx={{ mb: 1.5 }}
        />
        <TextField
          fullWidth
          size="small"
          type="number"
          label="Threads"
          value={env.threads}
          onChange={e =>
            updateEditEnv(index, { threads: Number(e.target.value) })
          }
          inputProps={{ min: 1, max: 32 }}
          sx={{ mb: 1.5 }}
        />
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel id={`dbt-settings-owner-${index}`}>Ownership</InputLabel>
          <Select
            labelId={`dbt-settings-owner-${index}`}
            label="Ownership"
            value={env.ownerUserId ?? ""}
            onChange={e =>
              updateEditEnv(index, { ownerUserId: e.target.value || undefined })
            }
          >
            <MenuItem value="">Shared — whole team</MenuItem>
            {user?.id && (
              <MenuItem value={user.id}>Personal — only me</MenuItem>
            )}
            {env.ownerUserId && env.ownerUserId !== user?.id && (
              <MenuItem value={env.ownerUserId}>
                Personal — another user
              </MenuItem>
            )}
          </Select>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 0.5, display: "block" }}
          >
            Personal environments become the owner&apos;s default build target
            and are hidden from teammates&apos; pickers. They can&apos;t be the
            project default or the production environment.
          </Typography>
        </FormControl>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mb: 0.5, fontWeight: 600 }}
        >
          Variables
        </Typography>
        {(editVarRows[index] ?? []).map((row, rowIndex) => (
          <Box
            key={rowIndex}
            sx={{ display: "flex", gap: 1, mb: 1, alignItems: "center" }}
          >
            <TextField
              size="small"
              label="Key"
              value={row.key}
              onChange={e =>
                updateVarRow(index, rowIndex, { key: e.target.value })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="Value"
              value={row.value}
              onChange={e =>
                updateVarRow(index, rowIndex, { value: e.target.value })
              }
              sx={{ flex: 1 }}
            />
            <IconButton
              size="small"
              aria-label="Remove variable"
              onClick={() => removeVarRow(index, rowIndex)}
            >
              <TrashIcon size={14} />
            </IconButton>
          </Box>
        ))}
        <Button
          size="small"
          startIcon={<PlusIcon size={14} />}
          onClick={() => addVarRow(index)}
        >
          Add variable
        </Button>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 0.5 }}
        >
          Passed to every dbt command as <code>--vars</code>; read in models via{" "}
          <code>{"{{ var('key') }}"}</code>.
        </Typography>
      </Box>
    );
  };

  return (
    <Drawer
      anchor="right"
      open={open && Boolean(projectId)}
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
          bgcolor: "background.paper",
        }}
      >
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
        >
          {selectedEnvName ? (
            <IconButton
              size="small"
              aria-label="Back to project"
              onClick={() => {
                setSelectedEnvName(null);
                setIsEditing(false);
                if (project) resetFromProject(project);
              }}
            >
              <BackIcon size={18} />
            </IconButton>
          ) : (
            <SettingsIcon size={18} strokeWidth={1.75} />
          )}
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={600} noWrap>
              {headerTitle}
            </Typography>
            {project && !selectedEnvName && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {project.name}
                {project.repo
                  ? ` · ${project.repo.branch} · ${project.repo.owner}/${project.repo.repo}`
                  : ""}
              </Typography>
            )}
            {project && selectedEnvName && (
              <Chip
                size="small"
                label={envBadge(selectedEnvName, project)}
                sx={{ mt: 0.25, height: 20, fontSize: "0.65rem" }}
              />
            )}
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {showOverviewEditButton && (
            <Button
              size="small"
              startIcon={<EditIcon size={14} />}
              onClick={() => setIsEditing(true)}
            >
              Edit
            </Button>
          )}
          <IconButton size="small" aria-label="Close" onClick={handleClose}>
            <CloseIcon size={18} />
          </IconButton>
        </Box>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 2 }}>
        {!project ? (
          <Typography variant="body2" color="text.secondary">
            Loading project…
          </Typography>
        ) : selectedEnvName && selectedEnv ? (
          isEditing && selectedEnvIndex >= 0 ? (
            renderEnvironmentEditor(selectedEnvIndex, true)
          ) : (
            <>
              <ReadOnlyField
                label="Environment type"
                value={
                  envBadge(selectedEnvName, project) === "DEV"
                    ? "Development"
                    : "Deployment"
                }
              />
              <ReadOnlyField
                label="dbt version"
                value={dbtVersionLabel(project.dbtVersion)}
              />
              <ReadOnlyField
                label="Connection"
                value={connectionLabel(selectedEnv.connectionId, connections)}
              />
              <ReadOnlyField
                label="Target schema"
                value={selectedEnv.targetSchema}
              />
              <ReadOnlyField
                label="Threads"
                value={String(selectedEnv.threads)}
              />
              <ReadOnlyField
                label="Ownership"
                value={
                  selectedEnv.ownerUserId
                    ? selectedEnv.ownerUserId === user?.id
                      ? "Personal — only me"
                      : "Personal — another user"
                    : "Shared — whole team"
                }
              />
              <Box sx={{ mb: 1.5 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                >
                  Variables
                </Typography>
                {Object.entries(selectedEnv.vars ?? {}).length === 0 ? (
                  <Typography variant="body2">—</Typography>
                ) : (
                  Object.entries(selectedEnv.vars ?? {}).map(([key, value]) => (
                    <Typography
                      key={key}
                      variant="body2"
                      sx={{ fontFamily: "monospace", fontSize: "0.78rem" }}
                    >
                      {key} ={" "}
                      {typeof value === "string"
                        ? value
                        : JSON.stringify(value)}
                    </Typography>
                  ))
                )}
              </Box>
            </>
          )
        ) : isEditing ? (
          <>
            <SettingsSection title="Overview">
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Project name"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                sx={{ mb: 1.5 }}
              />
              <Box sx={{ mb: 1.5 }}>
                <DbtVersionSelect
                  value={editDbtVersion}
                  onChange={setEditDbtVersion}
                  labelId="dbt-settings-version"
                />
              </Box>
              <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
                <InputLabel id="dbt-settings-default-env">
                  Default environment
                </InputLabel>
                <Select
                  labelId="dbt-settings-default-env"
                  label="Default environment"
                  value={editDefaultEnv}
                  onChange={e => setEditDefaultEnv(e.target.value)}
                >
                  {editEnvs.map(env => (
                    <MenuItem key={env.name} value={env.name}>
                      {env.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth size="small">
                <InputLabel id="dbt-settings-prod-env">
                  Production environment (defer target)
                </InputLabel>
                <Select
                  labelId="dbt-settings-prod-env"
                  label="Production environment (defer target)"
                  value={editProdEnv}
                  onChange={e => setEditProdEnv(e.target.value)}
                >
                  <MenuItem value="">
                    Auto — “prod” when it exists, else the default
                  </MenuItem>
                  {editEnvs
                    .filter(env => !env.ownerUserId)
                    .map(env => (
                      <MenuItem key={env.name} value={env.name}>
                        {env.name}
                      </MenuItem>
                    ))}
                </Select>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: "block" }}
                >
                  Ad-hoc builds defer to this environment’s last manifest, apps
                  resolve {"{{ dbt_schema }}"} against it, and it refuses ad-hoc
                  writes (deploys go through jobs).
                </Typography>
              </FormControl>
            </SettingsSection>

            <SettingsSection
              title="Environments"
              action={
                <Button
                  size="small"
                  startIcon={<PlusIcon size={14} />}
                  onClick={openCreateEnvModal}
                >
                  Add
                </Button>
              }
            >
              {connections.length === 0 && (
                <Typography variant="caption" color="error" display="block">
                  No dbt-compatible connections. Add a Postgres, BigQuery, or
                  other supported connection in Databases first.
                </Typography>
              )}
              {editEnvs.map((_, index) => renderEnvironmentEditor(index))}
            </SettingsSection>
          </>
        ) : (
          <>
            <SettingsSection title="Overview">
              <ReadOnlyField label="Project name" value={project.name} />
              <ReadOnlyField
                label="Project subdirectory"
                value={project.repo?.subdirectory?.trim() || "—"}
              />
              {project.repo ? (
                <ReadOnlyField
                  label="Repository"
                  value={`${project.repo.owner}/${project.repo.repo}`}
                  href={repoUrl}
                />
              ) : (
                <ReadOnlyField label="Repository" value="Not connected" />
              )}
              <ReadOnlyField
                label="Development connection"
                value={devConnectionName}
              />
              <ReadOnlyField
                label="Default environment"
                value={project.defaultEnvironment}
              />
              <ReadOnlyField
                label="Production environment (defer target)"
                value={
                  project.prodEnvironment
                    ? project.prodEnvironment
                    : `${resolveProdLikeEnvName(project) ?? "—"} (auto)`
                }
              />
              <ReadOnlyField
                label="dbt version"
                value={dbtVersionLabel(project.dbtVersion)}
              />
              {/* Per-USER setting (not project config): which environment
                  this user's drafts/builds target. Solo: the shared dev
                  default; teams: your personal environment. */}
              <Box sx={{ mt: 1.5 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="dbt-settings-my-env">
                    My development environment (per-user)
                  </InputLabel>
                  <Select
                    labelId="dbt-settings-my-env"
                    label="My development environment (per-user)"
                    value={project.myDevEnvironment ?? ""}
                    onChange={e => {
                      if (!projectId) return;
                      void setMyEnvironment(
                        workspaceId,
                        projectId,
                        e.target.value,
                      );
                    }}
                  >
                    <MenuItem value="">
                      Auto —{" "}
                      {resolveDevEnvName(
                        { ...project, myDevEnvironment: undefined },
                        user?.id,
                      ) ?? "default"}
                      {" (your personal env, else the default)"}
                    </MenuItem>
                    {visibleDbtEnvironments(project.environments, user?.id).map(
                      env => (
                        <MenuItem key={env.name} value={env.name}>
                          {env.ownerUserId
                            ? `${env.name} (personal)`
                            : env.name}
                        </MenuItem>
                      ),
                    )}
                  </Select>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.5, display: "block" }}
                  >
                    Where YOUR drafts and agent builds run. Solo workspaces: dev
                    is your personal target. Teams: pick (or provision) your
                    personal environment so builds never collide.
                  </Typography>
                </FormControl>
              </Box>
            </SettingsSection>

            <SettingsSection
              title="Environments"
              action={
                <Box sx={{ display: "flex", gap: 0.5 }}>
                  {!project.environments.some(
                    env => env.ownerUserId && env.ownerUserId === user?.id,
                  ) && (
                    <Button
                      size="small"
                      disabled={creatingPersonalEnv}
                      onClick={() => {
                        if (!projectId) return;
                        setCreatingPersonalEnv(true);
                        void ensurePersonalEnvironment(
                          workspaceId,
                          projectId,
                        ).finally(() => setCreatingPersonalEnv(false));
                      }}
                    >
                      {creatingPersonalEnv ? "Creating…" : "My dev environment"}
                    </Button>
                  )}
                  <Button
                    size="small"
                    startIcon={<PlusIcon size={14} />}
                    onClick={openCreateEnvModal}
                  >
                    Add environment
                  </Button>
                </Box>
              }
            >
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Environment</TableCell>
                    <TableCell>Connection</TableCell>
                    <TableCell>Schema</TableCell>
                    <TableCell width={32} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {project.environments.map(env => (
                    <TableRow
                      key={env.name}
                      hover
                      sx={{ cursor: "pointer" }}
                      onClick={() => setSelectedEnvName(env.name)}
                    >
                      <TableCell>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                          }}
                        >
                          {env.name}
                          {env.name === project.defaultEnvironment && (
                            <Chip
                              size="small"
                              label="default"
                              sx={{ height: 18, fontSize: "0.6rem" }}
                            />
                          )}
                          {env.ownerUserId ? (
                            <Chip
                              size="small"
                              color="info"
                              variant="outlined"
                              label={
                                env.ownerUserId === user?.id
                                  ? "personal"
                                  : "personal · other user"
                              }
                              sx={{ height: 18, fontSize: "0.6rem" }}
                            />
                          ) : (
                            <Chip
                              size="small"
                              label={envBadge(env.name, project)}
                              sx={{ height: 18, fontSize: "0.6rem" }}
                            />
                          )}
                        </Box>
                      </TableCell>
                      <TableCell sx={{ fontSize: "0.8rem" }}>
                        {connectionLabel(env.connectionId, connections)}
                      </TableCell>
                      <TableCell sx={{ fontSize: "0.8rem" }}>
                        {env.targetSchema}
                      </TableCell>
                      <TableCell>
                        <ChevronIcon size={16} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1, display: "block" }}
              >
                Click a row for details, or use Add environment / Edit to create
                prod, staging, or personal dev schemas.
              </Typography>
            </SettingsSection>

            {isRepoBound && project.repo && (
              <SettingsSection title="Git">
                <Box sx={{ mb: 1.5 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                  >
                    Branch
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    sx={{ mb: 0.5 }}
                  >
                    Deploy jobs, CI, and syncs build this branch. Your editor
                    checkout is independent (Version control panel).
                  </Typography>
                  <Select
                    size="small"
                    value={project.repo.branch}
                    disabled={savingTrackedBranch}
                    onChange={e =>
                      void handleTrackedBranchChange(e.target.value)
                    }
                    sx={{ minWidth: 260, maxWidth: "100%" }}
                  >
                    {[...new Set([project.repo.branch, ...remoteBranches])].map(
                      branch => (
                        <MenuItem key={branch} value={branch}>
                          {branch}
                        </MenuItem>
                      ),
                    )}
                  </Select>
                  {trackedBranchError && (
                    <Typography
                      variant="caption"
                      color="error"
                      display="block"
                      sx={{ mt: 0.5 }}
                    >
                      {trackedBranchError}
                    </Typography>
                  )}
                </Box>
                <ReadOnlyField
                  label="Last synced"
                  value={
                    project.repo.lastSyncedSha
                      ? `${formatSha(project.repo.lastSyncedSha)}${
                          project.repo.lastSyncedAt
                            ? ` · ${new Date(
                                project.repo.lastSyncedAt,
                              ).toLocaleString()}`
                            : ""
                        }`
                      : "—"
                  }
                />
                <Link
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body2"
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  Open on GitHub
                  <ExternalLinkIcon size={14} />
                </Link>

                <Box sx={{ mt: 2 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    sx={{ fontWeight: 600 }}
                  >
                    Protected branches
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    sx={{ mb: 1 }}
                  >
                    Direct commits to these branches are blocked in Mako —
                    changes go through a new branch and a pull request. Enable
                    matching branch protection on GitHub too for full coverage.
                  </Typography>
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 0.5,
                      mb: 1,
                    }}
                  >
                    {(project.protectedBranches ?? []).length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        No protected branches.
                      </Typography>
                    )}
                    {(project.protectedBranches ?? []).map(branch => (
                      <Chip
                        key={branch}
                        size="small"
                        icon={<LockIcon size={12} />}
                        label={branch}
                        disabled={savingProtection}
                        onDelete={() =>
                          void setProtectedBranches(
                            (project.protectedBranches ?? []).filter(
                              b => b !== branch,
                            ),
                          )
                        }
                      />
                    ))}
                  </Box>
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <TextField
                      size="small"
                      placeholder={project.repo.branch}
                      value={newProtectedBranch}
                      onChange={e => setNewProtectedBranch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleAddProtectedBranch();
                      }}
                      sx={{ flex: 1 }}
                    />
                    <Button
                      size="small"
                      disabled={savingProtection || !newProtectedBranch.trim()}
                      onClick={handleAddProtectedBranch}
                    >
                      Protect
                    </Button>
                  </Box>
                </Box>
              </SettingsSection>
            )}
          </>
        )}

        {saveError && (
          <Typography variant="caption" color="error" sx={{ mt: 1 }}>
            {saveError}
          </Typography>
        )}
      </Box>

      <Dialog
        open={envModalOpen}
        onClose={closeEnvModal}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add environment</DialogTitle>
        <DialogContent>
          {envModalDraft && (
            <Box sx={{ pt: 0.5 }}>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Environment name"
                value={envModalDraft.name}
                onChange={e =>
                  setEnvModalDraft(prev =>
                    prev ? { ...prev, name: e.target.value } : prev,
                  )
                }
                sx={{ mb: 1.5, mt: 0.5 }}
              />
              <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
                <InputLabel id="dbt-env-modal-conn">Connection</InputLabel>
                <Select
                  labelId="dbt-env-modal-conn"
                  label="Connection"
                  value={envModalDraft.connectionId}
                  onChange={e =>
                    setEnvModalDraft(prev =>
                      prev ? { ...prev, connectionId: e.target.value } : prev,
                    )
                  }
                >
                  {connections.map(conn => (
                    <MenuItem key={conn.id} value={conn.id}>
                      {conn.name} ({conn.type})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                fullWidth
                size="small"
                label="Target schema"
                value={envModalDraft.targetSchema}
                onChange={e =>
                  setEnvModalDraft(prev =>
                    prev ? { ...prev, targetSchema: e.target.value } : prev,
                  )
                }
                sx={{ mb: 1.5 }}
              />
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Threads"
                value={envModalDraft.threads}
                onChange={e =>
                  setEnvModalDraft(prev =>
                    prev ? { ...prev, threads: Number(e.target.value) } : prev,
                  )
                }
                inputProps={{ min: 1, max: 32 }}
                sx={{ mb: 1.5 }}
              />
              <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
                <InputLabel id="dbt-env-modal-owner">Ownership</InputLabel>
                <Select
                  labelId="dbt-env-modal-owner"
                  label="Ownership"
                  value={envModalDraft.ownerUserId ?? ""}
                  onChange={e =>
                    setEnvModalDraft(prev =>
                      prev
                        ? { ...prev, ownerUserId: e.target.value || undefined }
                        : prev,
                    )
                  }
                >
                  <MenuItem value="">Shared — whole team</MenuItem>
                  {user?.id && (
                    <MenuItem value={user.id}>Personal — only me</MenuItem>
                  )}
                </Select>
              </FormControl>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 0.5, fontWeight: 600 }}
              >
                Variables
              </Typography>
              {envModalVarRows.map((row, rowIndex) => (
                <Box
                  key={rowIndex}
                  sx={{ display: "flex", gap: 1, mb: 1, alignItems: "center" }}
                >
                  <TextField
                    size="small"
                    label="Key"
                    value={row.key}
                    onChange={e =>
                      setEnvModalVarRows(prev =>
                        prev.map((r, i) =>
                          i === rowIndex ? { ...r, key: e.target.value } : r,
                        ),
                      )
                    }
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    size="small"
                    label="Value"
                    value={row.value}
                    onChange={e =>
                      setEnvModalVarRows(prev =>
                        prev.map((r, i) =>
                          i === rowIndex ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    sx={{ flex: 1 }}
                  />
                  <IconButton
                    size="small"
                    aria-label="Remove variable"
                    onClick={() =>
                      setEnvModalVarRows(prev =>
                        prev.filter((_, i) => i !== rowIndex),
                      )
                    }
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                </Box>
              ))}
              <Button
                size="small"
                startIcon={<PlusIcon size={14} />}
                onClick={() =>
                  setEnvModalVarRows(prev => [...prev, { key: "", value: "" }])
                }
              >
                Add variable
              </Button>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.5 }}
              >
                Passed to every dbt command as <code>--vars</code>; read in
                models via <code>{"{{ var('key') }}"}</code>.
              </Typography>
            </Box>
          )}
          {envModalError && (
            <Typography
              variant="caption"
              color="error"
              sx={{ mt: 1, display: "block" }}
            >
              {envModalError}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeEnvModal} disabled={envModalSaving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleEnvModalSave()}
            disabled={envModalSaving || !envModalDraft?.name.trim()}
          >
            {envModalSaving ? "Saving…" : "Add environment"}
          </Button>
        </DialogActions>
      </Dialog>

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
          bgcolor: "background.paper",
        }}
      >
        {isEditing ? (
          <>
            <Button size="small" onClick={handleCancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button
              size="small"
              onClick={handleSave}
              disabled={saving || !editName.trim()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        ) : selectedEnvName ? (
          <Button
            size="small"
            startIcon={<EditIcon size={14} />}
            onClick={() => setIsEditing(true)}
          >
            Edit environment
          </Button>
        ) : (
          <Typography variant="caption" color="text.secondary">
            Edit to change project or add environments
          </Typography>
        )}
      </Box>
    </Drawer>
  );
}
