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

/** A name git and a URL are both happy with. */
export function isValidFolderName(name: string): boolean {
  const n = name.trim();
  return (
    n.length > 0 &&
    n.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(n) &&
    !n.endsWith(".") &&
    !n.endsWith(" ")
  );
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
  const valid = isValidFolderName(name);
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
          helperText={
            name.length > 0 && !valid
              ? "Letters, numbers, spaces, dots, dashes and underscores; must start with a letter or number."
              : " "
          }
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
