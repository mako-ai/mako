/**
 * The two dialogs the Apps explorer needs for its REAL folders (directories
 * in the workspace repo): naming a new one, and renaming an existing one.
 *
 * A git folder needs its name before it can exist (an empty directory is a
 * `.gitkeep` commit), so unlike a Mongo-backed tree it cannot appear first
 * and be renamed inline — hence a dialog rather than the tree's inline flow.
 */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import { appFolderNameError } from "../../lib/object-name-rules";

/**
 * Why `name` cannot be a new folder name, or null when it can — the
 * server's own rule (lib/object-name-rules.ts appFolderNameError, pinned to
 * the API by name-rules-parity.test.ts), in the server's words: Unicode letters and digits
 * included ("Café" is a folder here as it is on main), never a Windows
 * device name or an id look-alike.
 */
export function folderNameProblem(name: string): string | null {
  return appFolderNameError(name);
}

/** {@link folderNameProblem} as a yes/no. */
export function isValidFolderName(name: string): boolean {
  return folderNameProblem(name) === null;
}

interface FolderNameDialogProps {
  open: boolean;
  title: string;
  /** Where it goes, shown so the person knows which tree they are in. */
  parentLabel: string;
  initialName?: string;
  confirmLabel: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void | Promise<void>;
}

export function FolderNameDialog({
  open,
  title,
  parentLabel,
  initialName = "",
  confirmLabel,
  busy = false,
  onClose,
  onConfirm,
}: FolderNameDialogProps) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);
  const problem = folderNameProblem(name);
  const valid = problem === null;
  const submit = () => {
    if (!valid || busy) return;
    void onConfirm(name.trim());
  };
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label="Folder name"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          error={name.length > 0 && !valid}
          helperText={name.length > 0 && problem ? problem : " "}
          disabled={busy}
        />
        <Typography variant="caption" color="text.secondary">
          In {parentLabel}. A folder is a real directory in the workspace repo.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!valid || busy}>
          {busy ? "Saving…" : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
