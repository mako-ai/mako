/**
 * Rename or move a file of the dbt project, and what comes after.
 *
 * The box holds the file's FULL project path (`models/marts/orders.sql`),
 * prefilled, so moving to another folder and renaming are the same edit and
 * what is typed is exactly where the file goes. A path that cannot be used
 * is refused while it is typed, in the server's words (lib/dbt-rename-path);
 * the server checks again, and its refusal is shown here too.
 *
 * A rename can leave things only a person can fix: config that no longer
 * applies, the old warehouse table, consoles still naming it. Those change
 * what the next run builds, so `DbtRenameWarnings` keeps them on screen
 * until dismissed.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
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
import {
  dbtNodeNameOf,
  leavesNodeWarning,
  resolveDbtRenameTarget,
  splitRenameWarning,
} from "../lib/dbt-rename-path";

export interface DbtFileRenameDialogProps {
  open: boolean;
  /** The file's current project path. */
  fromPath: string;
  /** Every file path in the project, for "already exists" as it is typed. */
  existingPaths: readonly string[];
  /** Files open in this window that `ref()` the model this file is. */
  referencedBy?: readonly string[];
  onClose: () => void;
  /**
   * Do the rename. Resolves to the refusal to show (the dialog stays
   * open), or to null when it is done.
   */
  onConfirm: (toPath: string, updateRefs: boolean) => Promise<string | null>;
}

export function DbtFileRenameDialog({
  open,
  fromPath,
  existingPaths,
  referencedBy,
  onClose,
  onConfirm,
}: DbtFileRenameDialogProps) {
  const [value, setValue] = useState(fromPath);
  const [updateRefs, setUpdateRefs] = useState(true);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(fromPath);
    setUpdateRefs(true);
    setRefusal(null);
    setBusy(false);
  }, [open, fromPath]);

  const target = useMemo(
    () => resolveDbtRenameTarget(value, fromPath, existingPaths),
    [value, fromPath, existingPaths],
  );
  const error = target.ok ? refusal : target.error;
  const ready = target.ok && !target.unchanged && !busy;
  // Allowed, but worth knowing before it is done: the new path names no
  // model, so the file stops being one and nothing that names it follows.
  const leavesNode =
    target.ok && !target.unchanged
      ? leavesNodeWarning(fromPath, target.path, referencedBy)
      : null;

  const submit = async () => {
    if (!target.ok || target.unchanged || busy) return;
    setBusy(true);
    const refused = await onConfirm(target.path, updateRefs);
    setBusy(false);
    setRefusal(refused);
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
            setRefusal(null);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") void submit();
          }}
          error={Boolean(error)}
          helperText={
            error ??
            (ready && target.path !== value.trim()
              ? `Will be saved as ${target.path}`
              : "Change the folder to move the file, the name to rename it.")
          }
          slotProps={{ htmlInput: { spellCheck: false } }}
          sx={{ mt: 1 }}
        />
        {leavesNode && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {leavesNode}
          </Alert>
        )}
        {dbtNodeNameOf(fromPath) !== null && !leavesNode && (
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
                Also update <code>ref()</code> calls, job selectors and YAML
                entries that name it
              </Typography>
            }
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={!ready}>
          Rename
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface DbtRenameWarningsProps {
  /** null or empty: closed. */
  warnings: string[] | null;
  /** Where the file went, for the title. */
  renamedTo?: string;
  onClose: () => void;
}

/** What a rename left for a person to check: stays until dismissed. */
export function DbtRenameWarnings({
  warnings,
  renamedTo,
  onClose,
}: DbtRenameWarningsProps) {
  return (
    <Dialog
      open={Boolean(warnings?.length)}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        {renamedTo ? `Renamed to ${renamedTo}. Check these:` : "Check these"}
      </DialogTitle>
      <DialogContent>
        {(warnings ?? []).map((warning, i) => {
          const { message, detail } = splitRenameWarning(warning);
          return (
            <Alert key={i} severity="warning" sx={{ mb: 1 }}>
              {message}
              {detail && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{
                    color: "text.secondary",
                    mt: 0.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {detail}
                </Typography>
              )}
            </Alert>
          );
        })}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Got it</Button>
      </DialogActions>
    </Dialog>
  );
}
