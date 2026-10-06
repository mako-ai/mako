/**
 * Renaming an app: its NAME (the `title` in mako.json, what every list and
 * tab shows) and its LINK (the folder name — the slug `/apps/<slug>` is
 * made of). The two were one inline box that could only change the folder,
 * so the title silently never moved; now both are here, the link unchanged
 * unless touched. A changed link does not break the old one: the server
 * records the previous slug as an alias in mako.json, so every old link
 * and ref still opens the app (api/src/rename/handlers/app.ts). What the
 * server could NOT promise — the name was another app's old name too, and
 * that app loses it — comes back as `warnings`, which the explorer shows.
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
  /** The app's current display name — what "changed" is measured against. */
  currentTitle: string;
  /** The app's current folder name — what "changed" is measured against. */
  currentSlug: string;
  /**
   * A folder name typed before the dialog opened (an inline edit that got
   * through): the Link field starts from it, and it counts as a change
   * when it differs from `currentSlug`.
   */
  prefillSlug?: string;
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
  currentTitle,
  currentSlug,
  prefillSlug,
  slugIsLink,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: AppRenameDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const [slug, setSlug] = useState(prefillSlug ?? currentSlug);
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setSlug(prefillSlug ?? currentSlug);
    }
  }, [open, currentTitle, currentSlug, prefillSlug]);

  const titleChanged = title.trim() !== currentTitle && title.trim() !== "";
  const slugChanged = slug.trim() !== currentSlug;
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
                ? `/apps/${slug.trim() || currentSlug}`
                : "The folder name in the workspace repo; the link uses the app's id."
          }
          disabled={busy}
          slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
        />
        <Typography variant="caption" color="text.secondary">
          {slugChanged
            ? "The previous name is kept as an alias of this app, so its old link keeps opening it — unless another app also used that name before; you'll be told."
            : "Changing the link renames the app's folder; the previous name is kept as an alias."}
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
