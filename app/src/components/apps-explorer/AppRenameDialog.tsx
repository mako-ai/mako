/**
 * Renaming an app: its NAME (the `title` in mako.json, what every list and
 * tab shows) and its LINK (the folder name — the slug `/apps/<slug>` is
 * made of). The two were one inline box that could only change the folder,
 * so the title silently never moved; now both are here, the link unchanged
 * unless touched. A changed link does not break the old one: the server
 * records the previous slug as an alias in mako.json, so every old link
 * and ref still opens the app (api/src/rename/handlers/app.ts).
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
import { isValidFolderName } from "./AppFolderDialogs";

export interface AppRenameDialogProps {
  open: boolean;
  /** The app's current display name. */
  initialTitle: string;
  /** The app's current folder name. */
  initialSlug: string;
  /** Whether the link is addressed by the slug (`/apps/<slug>`) or the id. */
  slugIsLink: boolean;
  busy?: boolean;
  /** The server's refusal, shown under the fields until the next attempt. */
  error?: string | null;
  onClose: () => void;
  /** Only the changed fields are passed; both undefined never happens. */
  onConfirm: (change: {
    title?: string;
    slug?: string;
  }) => void | Promise<void>;
}

export function AppRenameDialog({
  open,
  initialTitle,
  initialSlug,
  slugIsLink,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: AppRenameDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [slug, setSlug] = useState(initialSlug);
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setSlug(initialSlug);
    }
  }, [open, initialTitle, initialSlug]);

  const titleChanged = title.trim() !== initialTitle && title.trim() !== "";
  const slugChanged = slug.trim() !== initialSlug;
  const slugValid = !slugChanged || isValidFolderName(slug);
  const titleValid = title.trim() !== "";
  const canSubmit =
    !busy && titleValid && slugValid && (titleChanged || slugChanged);

  const submit = () => {
    if (!canSubmit) return;
    void onConfirm({
      ...(titleChanged ? { title: title.trim() } : {}),
      ...(slugChanged ? { slug: slug.trim() } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Rename app</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label="Name"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          error={!titleValid}
          helperText={!titleValid ? "An app needs a name." : " "}
          disabled={busy}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Link"
          value={slug}
          onChange={e => setSlug(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          error={!slugValid}
          helperText={
            !slugValid
              ? "Letters, numbers, spaces, dots, dashes and underscores; must start with a letter or number."
              : slugIsLink
                ? `/apps/${slug.trim() || initialSlug}`
                : "The folder name in the workspace repo; the link uses the app's id."
          }
          disabled={busy}
          slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
        />
        <Typography variant="caption" color="text.secondary">
          {slugChanged
            ? "The old link keeps working: the previous name is kept as an alias of the app."
            : "Changing the link renames the app's folder; the old link keeps working."}
        </Typography>
        {error && (
          <Typography
            variant="caption"
            color="error"
            sx={{ display: "block", mt: 1 }}
          >
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {busy ? "Saving…" : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
