/**
 * Who configures a source connection: its editors. They edit it, reveal or
 * replace its key, delete it, and change this list. Being an admin is not
 * enough once a connection has editors; one with none (created before
 * creators were recorded) is configured by every admin until someone is
 * added. The workspace owner always can. Everyone else sees the connection
 * and uses it.
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
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { KeyRound } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useSourceConnectionEntitiesStore,
  type SourceConnectionEditors,
} from "../store/sourceConnectionEntitiesStore";

type Person = { userId: string; email: string; role: string };

function initials(email: string) {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function ConnectionEditorsPanel({
  connectionId,
}: {
  connectionId: string;
}) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const getEditors = useSourceConnectionEntitiesStore(s => s.getEditors);
  const setEditors = useSourceConnectionEntitiesStore(s => s.setEditors);
  const [state, setState] = useState<SourceConnectionEditors | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setState(await getEditors(workspaceId, connectionId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, connectionId, getEditors]);

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
    p => p.role !== "viewer" && !state?.editors.includes(p.userId),
  );

  const save = async (next: string[]) => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await setEditors(workspaceId, connectionId, next);
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

  const last = state.editors.length <= 1;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "center" }}>
        <KeyRound size={16} />
        <Typography variant="subtitle2">Editors</Typography>
        {busy && <CircularProgress size={14} />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Editors change this connection, see its key and choose the other
        editors. Admins are not editors unless they are added here. The
        workspace owner can always step in.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {state.editors.length === 0 && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          No editors yet. Until someone is added, the workspace owner and every
          admin can configure this connection. Add the people who manage this
          key.
        </Alert>
      )}

      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        {state.editors.map(id => {
          const person = describe(id);
          return (
            <Chip
              key={id}
              avatar={<Avatar>{initials(person.email)}</Avatar>}
              label={person.email}
              onDelete={
                state.canEdit && !last && !busy
                  ? () => void save(state.editors.filter(e => e !== id))
                  : undefined
              }
            />
          );
        })}
      </Stack>

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
            if (person) void save([...state.editors, person.userId]);
          }}
          renderInput={params => (
            <TextField {...params} placeholder="Add an editor" />
          )}
          noOptionsText="Every member who can be an editor already is"
        />
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Only an editor or the workspace owner can change this list.
        </Typography>
      )}
    </Box>
  );
}
