/**
 * Who configures a source connection: its managers. They edit it, reveal or
 * replace its key, delete it, and change this list. Being an admin is not
 * enough. A connection with no manager who can act today (created before
 * creators were recorded, or whose managers left) lists the workspace owner,
 * who always can. Everyone else sees the connection and uses it.
 *
 * The list and whether the caller may change it come with the connection's
 * row. Changes save as they are made.
 */
import { useEffect, useState } from "react";
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
import { useSourceConnectionEntitiesStore } from "../store/sourceConnectionEntitiesStore";
import { initials } from "../lib/initials";

export default function ConnectionManagersPanel({
  connectionId,
}: {
  connectionId: string;
}) {
  const { currentWorkspace, members, loadMembers } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const fetchOne = useSourceConnectionEntitiesStore(s => s.fetchOne);
  const setManagers = useSourceConnectionEntitiesStore(s => s.setManagers);
  const row = useSourceConnectionEntitiesStore(s =>
    workspaceId ? s.entities[`${workspaceId}:${connectionId}`] : undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (workspaceId) void fetchOne(workspaceId, connectionId);
    void loadMembers?.();
  }, [workspaceId, connectionId, fetchOne, loadMembers]);

  const managers = row?.managers ?? [];
  const canEdit = row?.canEdit === true;
  const describe = (userId: string) =>
    members.find(m => m.userId === userId) ?? {
      userId,
      email: "Unknown member",
      role: "",
    };
  // Viewers cannot configure connections, so they are not offered.
  const candidates = members.filter(
    m => m.role !== "viewer" && !managers.includes(m.userId),
  );

  const save = async (next: string[]) => {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await setManagers(workspaceId, connectionId, next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!row) {
    return (
      <Box sx={{ py: 2, textAlign: "center" }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  const last = managers.length <= 1;

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
              {canEdit && <TableCell align="right" />}
            </TableRow>
          </TableHead>
          <TableBody>
            {managers.map(id => {
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
                  {canEdit && (
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
                              void save(managers.filter(e => e !== id))
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

      {canEdit ? (
        <Autocomplete
          sx={{ mt: 1.5, maxWidth: 420 }}
          size="small"
          options={candidates}
          value={null}
          disabled={busy}
          getOptionLabel={p => p.email}
          isOptionEqualToValue={(a, b) => a.userId === b.userId}
          onChange={(_, person) => {
            if (person) void save([...managers, person.userId]);
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
