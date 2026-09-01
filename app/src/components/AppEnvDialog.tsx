/**
 * App environment variables dialog — the UI over the per-app env vault
 * (api/src/apps/env.service.ts).
 *
 * The one concept a user must get right is the secret flag, so the dialog
 * teaches it where the choice is made: non-secret values reach the dev server
 * AND the published build (`VITE_*` ones are inlined into the public bundle —
 * correct for Maps keys, Supabase anon keys and the rest of the publishable
 * class), while secrets exist only in sandbox dev processes and never touch
 * a build. The server refuses a secret with the `VITE_` prefix; this dialog
 * surfaces that refusal rather than pre-hiding the combination, so the user
 * reads WHY instead of wondering where the checkbox went.
 *
 * Secrets never echo their value back (the list returns only their key), so
 * a stored secret renders as dots and can be overwritten or deleted, never
 * revealed.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Pencil as EditIcon, Trash2 as DeleteIcon } from "lucide-react";
import { useAppsStore, type AppEnvVar } from "../store/appsStore";
import { useConfirm } from "./ConfirmDialog";

interface AppEnvDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  appId: string;
  appTitle?: string;
}

export default function AppEnvDialog({
  open,
  onClose,
  workspaceId,
  appId,
  appTitle,
}: AppEnvDialogProps) {
  const fetchAppEnv = useAppsStore(s => s.fetchAppEnv);
  const setAppEnvVar = useAppsStore(s => s.setAppEnvVar);
  const deleteAppEnvVar = useAppsStore(s => s.deleteAppEnvVar);
  const confirm = useConfirm();

  const [vars, setVars] = useState<AppEnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVars(null);
    setError(null);
    setKey("");
    setValue("");
    setSecret(false);
    fetchAppEnv(workspaceId, appId)
      .then(setVars)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load variables");
        setVars([]);
      });
  }, [open, workspaceId, appId, fetchAppEnv]);

  const handleSave = useCallback(async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await setAppEnvVar(workspaceId, appId, {
        key: key.trim(),
        value,
        secret,
      });
      setVars(next);
      setKey("");
      setValue("");
      setSecret(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the variable");
    } finally {
      setSaving(false);
    }
  }, [workspaceId, appId, key, value, secret, setAppEnvVar]);

  const handleDelete = useCallback(
    async (varKey: string, isSecret: boolean) => {
      if (
        isSecret &&
        !(await confirm({
          title: `Delete ${varKey}?`,
          body: "Secret values are never shown again — deleting one means re-entering it to get it back.",
          confirmLabel: "Delete",
          destructive: true,
        }))
      ) {
        return;
      }
      setError(null);
      try {
        await deleteAppEnvVar(workspaceId, appId, varKey);
        setVars(v => (v ? v.filter(item => item.key !== varKey) : v));
      } catch (e: unknown) {
        setError(
          e instanceof Error ? e.message : "Could not delete the variable",
        );
      }
    },
    [workspaceId, appId, deleteAppEnvVar, confirm],
  );

  // Prefill the form from a row: non-secret vars bring their value along;
  // a secret brings only its name (there is no value to bring).
  const handleEdit = useCallback((v: AppEnvVar) => {
    setKey(v.key);
    setValue(v.value ?? "");
    setSecret(v.secret);
  }, []);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        Environment variables{appTitle ? ` — ${appTitle}` : ""}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Values are encrypted at rest and injected when a process starts.
          Regular variables reach the dev server and the published build —{" "}
          <code>VITE_*</code> ones become part of the public bundle, which is
          right for publishable keys (Google Maps, Supabase anon keys). Secrets
          stay in dev only and are never built into a published app. A running
          dev server picks changes up on its next restart.
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {vars === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={22} />
          </Box>
        ) : vars.length > 0 ? (
          <Table size="small" sx={{ mb: 2 }}>
            <TableHead>
              <TableRow>
                <TableCell>Key</TableCell>
                <TableCell>Value</TableCell>
                <TableCell padding="none" />
              </TableRow>
            </TableHead>
            <TableBody>
              {vars.map(v => (
                <TableRow key={v.key} hover>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {v.key}
                  </TableCell>
                  <TableCell
                    sx={{
                      fontFamily: "monospace",
                      maxWidth: 220,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: v.secret ? "text.secondary" : undefined,
                    }}
                  >
                    {v.secret ? "•••••••• (secret)" : v.value}
                  </TableCell>
                  <TableCell padding="none" align="right">
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => handleEdit(v)}>
                        <EditIcon size={15} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        onClick={() => void handleDelete(v.key, v.secret)}
                      >
                        <DeleteIcon size={15} />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 2, fontStyle: "italic" }}
          >
            No variables yet.
          </Typography>
        )}
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
          <TextField
            size="small"
            label="Key"
            placeholder="VITE_GOOGLE_MAPS_API_KEY"
            value={key}
            onChange={e => setKey(e.target.value)}
            sx={{ flex: 1, "& input": { fontFamily: "monospace" } }}
          />
          <TextField
            size="small"
            label="Value"
            value={value}
            onChange={e => setValue(e.target.value)}
            sx={{ flex: 1.4, "& input": { fontFamily: "monospace" } }}
          />
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mt: 0.5,
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={secret}
                onChange={e => setSecret(e.target.checked)}
              />
            }
            label={
              <Typography variant="body2">
                Secret (dev only, never in published builds)
              </Typography>
            }
          />
          <Button
            variant="contained"
            size="small"
            disabled={saving || !key.trim()}
            onClick={() => void handleSave()}
          >
            {saving
              ? "Saving…"
              : vars?.some(v => v.key === key.trim())
                ? "Update"
                : "Add"}
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
