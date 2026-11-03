/**
 * "Share with workspace": the explicit step that moves a personal app into
 * the Workspace tree. Asks for the one line colleagues will see next to it
 * (written into the app's mako.json in the same commit).
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

export default function ShareWithWorkspaceDialog(props: {
  open: boolean;
  appTitle: string;
  initialDescription?: string;
  onClose: () => void;
  onSubmit: (description: string) => Promise<boolean>;
}) {
  const { open, appTitle, initialDescription, onClose, onSubmit } = props;
  const [description, setDescription] = useState(initialDescription ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setDescription(initialDescription ?? "");
  }, [open, initialDescription]);

  const trimmed = description.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(trimmed)) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth>
      <DialogTitle>Share “{appTitle}” with the workspace</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The app moves from your personal folder to the Workspace tree, where
          everyone can find it. Its link, deployment and sharing settings stay
          the same.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="What is it for? (one line)"
          value={description}
          slotProps={{ htmlInput: { maxLength: 300 } }}
          onChange={e => setDescription(e.target.value.replace(/\n/g, " "))}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={!trimmed || busy}
        >
          Share with workspace
        </Button>
      </DialogActions>
    </Dialog>
  );
}
