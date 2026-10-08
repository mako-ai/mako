/**
 * Rename / move a dbt project file. The box holds the file's FULL project
 * path (`models/marts/orders.sql`), prefilled, so moving to another folder
 * and renaming are the same edit — and what is typed is exactly where the
 * file goes (a folder-relative box used to nest `models/staging/x.sql`
 * under the current folder). Problems are said inline while typing; the
 * server checks again and its refusal shows here too.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
} from "@mui/material";
import { resolveDbtRenameTarget } from "../lib/dbt-rename-path";
import { isRefableDbtPath } from "../lib/dbt-editor-logic";

export interface DbtFileRenameDialogProps {
  open: boolean;
  /** The file's current project-relative path. */
  fromPath: string;
  /** Every file path in the project, for "already exists" checks. */
  existingPaths: readonly string[];
  onClose: () => void;
  /**
   * Do the rename. Resolve to an error message to keep the dialog open and
   * show it; resolve to null when it is done.
   */
  onConfirm: (toPath: string, updateRefs: boolean) => Promise<string | null>;
}

export function DbtFileRenameDialog({
  open,
  fromPath,
  existingPaths,
  onClose,
  onConfirm,
}: DbtFileRenameDialogProps) {
  const [value, setValue] = useState(fromPath);
  const [updateRefs, setUpdateRefs] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(fromPath);
      setUpdateRefs(true);
      setServerError(null);
      setBusy(false);
    }
  }, [open, fromPath]);

  const target = useMemo(
    () => resolveDbtRenameTarget(value, fromPath, existingPaths),
    [value, fromPath, existingPaths],
  );
  const error = !target.ok ? target.error : serverError;
  const canSubmit = target.ok && !target.unchanged && !busy;

  const submit = async () => {
    if (!target.ok || target.unchanged || busy) return;
    setBusy(true);
    const refused = await onConfirm(target.path, updateRefs);
    setBusy(false);
    if (refused) setServerError(refused);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Rename or move file</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Path in the dbt project"
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setServerError(null);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") void submit();
          }}
          error={Boolean(error)}
          helperText={
            error ??
            (target.ok && !target.unchanged && target.path !== value.trim()
              ? `Will be saved as ${target.path}`
              : "Change the folder to move the file, the name to rename it.")
          }
          inputProps={{ spellCheck: false }}
          sx={{ mt: 1 }}
        />
        {isRefableDbtPath(fromPath) && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                size="small"
                checked={updateRefs}
                onChange={e => setUpdateRefs(e.target.checked)}
              />
            }
            label={
              <Typography variant="body2">
                Also update <code>ref()</code> calls and job selectors that name
                this model
              </Typography>
            }
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          Rename
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default DbtFileRenameDialog;
