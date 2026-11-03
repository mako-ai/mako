/**
 * The Access tab of a connection (rfcs/data-source-access.md): everyone in
 * the workspace reads; only the people and workflows listed write, each
 * anywhere or only to one schema or table.
 *
 * Changes save as they are made. While the workspace only reports, the tab
 * also shows who really wrote here lately, to allow them in one click before
 * anything is refused.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  BookOpen,
  Database,
  Folder,
  PenLine,
  Route,
  Table2,
  Users,
  X,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useSchemaStore,
  type ConnectionRecentWriter,
  type ConnectionWriter,
  type ConnectionWriters,
} from "../store/schemaStore";
import { useWorkflowsStore } from "../store/workflowsStore";

type Who = { principal: string; label: string; kind: "person" | "workflow" };

const ANYWHERE = "Anywhere";

function whereLabel(where?: string | null) {
  if (!where) return { text: "Anywhere", kind: "anywhere" as const };
  return where.includes(".")
    ? { text: where, kind: "table" as const }
    : { text: where, kind: "schema" as const };
}

type TreeLoader = ReturnType<typeof useSchemaStore.getState>;

/**
 * What a writer can be limited to: the schemas or datasets a write names.
 * Where the tree starts with databases that hold schemas (Postgres, Redshift),
 * those schemas; where a database is itself the namespace (MySQL,
 * ClickHouse), the databases.
 */
async function writePlaces(
  workspaceId: string,
  connectionId: string,
  ensureTreeRoot: TreeLoader["ensureTreeRoot"],
  ensureTreeChildren: TreeLoader["ensureTreeChildren"],
): Promise<string[]> {
  const roots = (await ensureTreeRoot(workspaceId, connectionId)) ?? [];
  const databases = roots.filter(n => n.kind === "database").slice(0, 5);
  const children = await Promise.all(
    databases.map(n =>
      ensureTreeChildren(workspaceId, connectionId, n).catch(() => []),
    ),
  );
  const schemas = children.flat().filter(n => n.kind === "schema");
  const places = schemas.length > 0 ? schemas : roots;
  return [...new Set(places.map(n => n.label))];
}

function initials(text: string) {
  const name = text.split("@")[0] ?? text;
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function ConnectionWritersPanel({
  connectionId,
  connectionName,
}: {
  connectionId: string;
  connectionName: string;
}) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const getWriters = useSchemaStore(s => s.getConnectionWriters);
  const setWriters = useSchemaStore(s => s.setConnectionWriters);
  const ensureTreeRoot = useSchemaStore(s => s.ensureTreeRoot);
  const ensureTreeChildren = useSchemaStore(s => s.ensureTreeChildren);
  const fetchWorkflows = useWorkflowsStore(s => s.fetchOverview);
  const workflows = useWorkflowsStore(s =>
    workspaceId ? s.overviewByWorkspace[workspaceId]?.workflows : undefined,
  );

  const [state, setState] = useState<ConnectionWriters | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<Who | null>(null);
  const [where, setWhere] = useState<string>(ANYWHERE);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setState(await getWriters(workspaceId, connectionId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, connectionId, getWriters]);

  useEffect(() => {
    if (!workspaceId) return;
    void load();
    void loadMembers?.();
    void fetchWorkflows(workspaceId);
    void writePlaces(
      workspaceId,
      connectionId,
      ensureTreeRoot,
      ensureTreeChildren,
    )
      .then(setNamespaces)
      .catch(() => setNamespaces([]));
  }, [
    workspaceId,
    connectionId,
    load,
    loadMembers,
    fetchWorkflows,
    ensureTreeRoot,
    ensureTreeChildren,
  ]);

  const people = useMemo<Who[]>(
    () =>
      members.map(m => ({
        principal: `user:${m.userId}`,
        label: m.email,
        kind: "person",
      })),
    [members],
  );
  const flows = useMemo<Who[]>(
    () =>
      (workflows ?? []).map(w => ({
        principal: `workflow:${w.workflowId}`,
        label: w.workflowId,
        kind: "workflow",
      })),
    [workflows],
  );
  const describe = useCallback(
    (principal: string): Who => {
      const known = [...people, ...flows].find(w => w.principal === principal);
      if (known) return known;
      const [kind, name] = principal.split(":");
      return {
        principal,
        label: name ?? principal,
        kind: kind === "workflow" ? "workflow" : "person",
      };
    },
    [people, flows],
  );

  const save = async (next: ConnectionWriter[]): Promise<boolean> => {
    if (!workspaceId) return false;
    setBusy(true);
    try {
      await setWriters(
        workspaceId,
        connectionId,
        next.map(w => ({
          principal: w.principal,
          ...(w.where ? { where: w.where } : {}),
        })),
      );
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const allow = async (principal: string, place?: string) => {
    if (!state) return;
    const scope = place && place !== ANYWHERE ? place.trim() : undefined;
    if (await save([...state.writers, { principal, where: scope }])) {
      setWho(null);
      setWhere(ANYWHERE);
    }
  };

  const remove = (writer: ConnectionWriter) =>
    state &&
    save(
      state.writers.filter(
        w => !(w.principal === writer.principal && w.where === writer.where),
      ),
    );

  if (!state) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <CircularProgress size={22} />
        )}
      </Box>
    );
  }

  const allowed = new Set(state.writers.map(w => w.principal));
  const suggestions = state.recent.filter(r => r.uncovered.length > 0);

  return (
    <Stack spacing={2.5} sx={{ py: 1 }}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* At a glance */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
          gap: 1.5,
        }}
      >
        <Summary
          icon={<BookOpen size={16} />}
          label="Read"
          value="Everyone in the workspace"
        />
        <Summary
          icon={<PenLine size={16} />}
          label="Write"
          value={
            state.writers.length === 0
              ? "No one"
              : `${state.writers.length} allowed`
          }
          tone={state.writers.length === 0 ? "muted" : "normal"}
        />
      </Box>

      {/* Allowed */}
      <Box>
        <SectionTitle>Allowed to write</SectionTitle>
        {state.writers.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
            No one writes through {connectionName}. Syncs, flows and dbt are not
            affected.
          </Typography>
        ) : (
          <Box
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1.5,
              overflow: "hidden",
            }}
          >
            {state.writers.map((writer, index) => {
              const w = describe(writer.principal);
              const place = whereLabel(writer.where);
              return (
                <Box
                  key={`${writer.principal} ${writer.where ?? ""}`}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    px: 1.5,
                    py: 1,
                    borderTop: index ? 1 : 0,
                    borderColor: "divider",
                  }}
                >
                  <PrincipalAvatar who={w} />
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                    }}
                  >
                    <Typography variant="body2" noWrap>
                      {w.label}
                    </Typography>
                    {w.kind === "workflow" && (
                      <Chip
                        size="small"
                        label="Workflow"
                        sx={{ height: 20, fontSize: 11 }}
                      />
                    )}
                  </Box>
                  <PlaceChip place={place} />
                  {state.canEdit && (
                    <Tooltip title="Remove">
                      <span>
                        <IconButton
                          size="small"
                          disabled={busy}
                          aria-label={`Remove ${w.label}`}
                          onClick={() => void remove(writer)}
                        >
                          <X size={16} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {state.canEdit && (
          <Box
            sx={{
              mt: 1.5,
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1.4fr 1fr auto" },
              gap: 1,
              alignItems: "stretch",
            }}
          >
            <Autocomplete
              size="small"
              options={[...people, ...flows]}
              groupBy={o => (o.kind === "workflow" ? "Workflows" : "People")}
              getOptionLabel={o => o.label}
              isOptionEqualToValue={(a, b) => a.principal === b.principal}
              value={who}
              onChange={(_, value) => setWho(value)}
              renderInput={params => (
                <TextField
                  {...params}
                  margin="none"
                  placeholder="Person or workflow"
                />
              )}
            />
            <Autocomplete
              size="small"
              freeSolo
              options={[ANYWHERE, ...namespaces]}
              value={where}
              onChange={(_, value) => setWhere(value ?? ANYWHERE)}
              onInputChange={(_, value) => setWhere(value || ANYWHERE)}
              renderInput={params => (
                <TextField
                  {...params}
                  margin="none"
                  placeholder="schema or schema.table"
                />
              )}
            />
            <Button
              variant="contained"
              disableElevation
              disabled={!who || busy}
              onClick={() => who && void allow(who.principal, where)}
              sx={{ px: 2.5 }}
            >
              Allow
            </Button>
          </Box>
        )}
        {!state.canEdit && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1 }}
          >
            Only the workspace owner and admins can change who writes.
          </Typography>
        )}
      </Box>

      {/* What really happens */}
      {suggestions.length > 0 && (
        <Box>
          <SectionTitle>Tried to write in the last 30 days</SectionTitle>
          <Stack spacing={0.5}>
            {suggestions.map(r => (
              <RecentRow
                key={r.principal}
                recent={r}
                who={describe(r.principal)}
                allowed={allowed.has(r.principal)}
                canEdit={state.canEdit}
                busy={busy}
                onAllow={() => void allow(r.principal)}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function Summary({
  icon,
  label,
  value,
  tone = "normal",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "normal" | "muted";
}) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 1.5,
        bgcolor: theme => alpha(theme.palette.text.primary, 0.04),
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          color: "text.secondary",
        }}
      >
        {icon}
        <Typography variant="caption">{label}</Typography>
      </Box>
      <Typography
        variant="body2"
        sx={{
          mt: 0.5,
          fontWeight: 500,
          color: tone === "muted" ? "text.secondary" : "text.primary",
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="subtitle2" sx={{ mb: 1 }}>
      {children}
    </Typography>
  );
}

function PrincipalAvatar({ who }: { who: Who }) {
  return (
    <Avatar
      variant={who.kind === "workflow" ? "rounded" : "circular"}
      sx={{
        width: 28,
        height: 28,
        fontSize: 12,
        bgcolor: theme =>
          who.kind === "workflow"
            ? alpha(theme.palette.text.primary, 0.08)
            : alpha(theme.palette.primary.main, 0.12),
        color: who.kind === "workflow" ? "text.secondary" : "primary.main",
      }}
    >
      {who.kind === "workflow" ? <Route size={15} /> : initials(who.label)}
    </Avatar>
  );
}

function PlaceChip({
  place,
}: {
  place: { text: string; kind: "anywhere" | "schema" | "table" };
}) {
  const icon =
    place.kind === "anywhere" ? (
      <Database size={14} />
    ) : place.kind === "schema" ? (
      <Folder size={14} />
    ) : (
      <Table2 size={14} />
    );
  return (
    <Chip
      size="small"
      variant="outlined"
      icon={icon}
      label={place.text}
      sx={{
        fontFamily: place.kind === "anywhere" ? undefined : "monospace",
        "& .MuiChip-icon": { ml: 0.75 },
      }}
    />
  );
}

function RecentRow({
  recent,
  who,
  allowed,
  canEdit,
  busy,
  onAllow,
}: {
  recent: ConnectionRecentWriter;
  who: Who;
  allowed: boolean;
  canEdit: boolean;
  busy: boolean;
  onAllow: () => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.5 }}>
      <PrincipalAvatar who={who} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {who.label}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ display: "block" }}
        >
          Refused on {recent.uncovered.join(", ")}
        </Typography>
      </Box>
      {!allowed && canEdit && (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          onClick={onAllow}
        >
          Allow
        </Button>
      )}
      {!allowed && !canEdit && (
        <Chip size="small" icon={<Users size={14} />} label="Not allowed" />
      )}
    </Box>
  );
}
