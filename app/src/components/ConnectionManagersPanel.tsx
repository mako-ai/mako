/**
 * Who configures a source connection: its managers. They edit it, reveal or
 * replace its key, delete it, and change this list. Being an admin is not
 * enough; a connection with none (created before creators were recorded,
 * or whose managers left) is managed by the workspace owner. The workspace
 * owner always can. Everyone else sees the connection and uses it.
 *
 * Changes save as they are made.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { KeyRound, X } from "lucide-react";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useSourceConnectionEntitiesStore,
  type SourceConnectionManagers,
} from "../store/sourceConnectionEntitiesStore";

type Person = { userId: string; email: string; role: string };

function initials(email: string) {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function ConnectionManagersPanel({
  connectionId,
}: {
  connectionId: string;
}) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const getManagers = useSourceConnectionEntitiesStore(s => s.getManagers);
  const setManagers = useSourceConnectionEntitiesStore(s => s.setManagers);
  const [state, setState] = useState<SourceConnectionManagers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setState(await getManagers(workspaceId, connectionId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, connectionId, getManagers]);

  useEffect(() => {
    void load();
    void loadMembers?.();
  }, [load, loadMembers]);

  const people = useMemo<Person[]>(
    () =>
      members.map(m => ({ userId: m.userId, email: m.email, role: m.role })),
    [members],
  );
  const describe = (userId: string): Person =>
    people.find(p => p.userId === userId) ?? {
      userId,
      email: "Unknown member",
      role: "",
    };
  // Viewers cannot configure connections, so they are not offered.
  const candidates = people.filter(
    p => p.role !== "viewer" && !state?.managers.includes(p.userId),
  );

  const save = async (next: string[]) => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await setManagers(workspaceId, connectionId, next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return error ? (
      <Alert severity="error">{error}</Alert>
    ) : (
      <Box sx={{ py: 2, textAlign: "center" }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  const last = state.managers.length <= 1;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "center" }}>
        <KeyRound size={16} />
        <Typography variant="subtitle2">Managers</Typography>
        {busy && <CircularProgress size={14} />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Managers change this connection, see its key and choose the other
        managers. Admins are not managers unless they are added here. The
        workspace owner can always step in.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {state.managers.length === 0 && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          No managers yet. The workspace owner manages this connection until
          someone is added.
        </Alert>
      )}

      {state.managers.length > 0 && (
        <TableContainer
          component={Paper}
          variant="outlined"
          sx={{ boxShadow: "none" }}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Manager</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Workspace role</TableCell>
                {state.canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {state.managers.map(id => {
                const person = describe(id);
                const isMe = id === user?.id;
                return (
                  <TableRow key={id} hover>
                    <TableCell>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: "center" }}
                      >
                        <Avatar
                          sx={{ width: 28, height: 28, fontSize: "0.75rem" }}
                        >
                          {initials(person.email)}
                        </Avatar>
                        <Typography variant="body2">
                          {person.email}
                          {isMe && (
                            <Typography
                              component="span"
                              variant="body2"
                              color="text.secondary"
                            >
                              {" "}
                              (you)
                            </Typography>
                          )}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {person.role && <Chip label={person.role} size="small" />}
                    </TableCell>
                    {state.canEdit && (
                      <TableCell align="right">
                        <Tooltip
                          title={
                            last
                              ? "A connection keeps at least one manager"
                              : "Remove manager"
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              aria-label={`Remove ${person.email}`}
                              disabled={last || busy}
                              onClick={() =>
                                void save(state.managers.filter(e => e !== id))
                              }
                            >
                              <X size={16} />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {state.canEdit ? (
        <Autocomplete
          sx={{ mt: 1.5, maxWidth: 420 }}
          size="small"
          options={candidates}
          value={null}
          disabled={busy}
          getOptionLabel={p => p.email}
          isOptionEqualToValue={(a, b) => a.userId === b.userId}
          onChange={(_, person) => {
            if (person) void save([...state.managers, person.userId]);
          }}
          renderInput={params => (
            <TextField {...params} placeholder="Add a manager" />
          )}
          noOptionsText="Every member who can be a manager already is"
        />
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Only a manager or the workspace owner can change this list.
        </Typography>
      )}
    </Box>
  );
}
