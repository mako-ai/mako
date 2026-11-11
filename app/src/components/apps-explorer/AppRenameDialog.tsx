/**
 * Renaming an app: its NAME (the `title` in mako.json, what every list and
 * tab shows) and its LINK (the folder name `/apps/<link>` is made of),
 * edited separately — changing one never changes the other. A new link does
 * not break the old one: the server keeps it in mako.json, so it still
 * opens the app (api/src/rename/handlers/app.ts).
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
import {
  appLinkError,
  appTitleError,
  normalizeAppName,
  normalizeObjectName,
} from "../../lib/object-name-rules";

export interface AppRenameDialogProps {
  open: boolean;
  currentTitle: string;
  /** The app's folder name today. */
  currentSlug: string;
  /** Whether the link is `/apps/<slug>` (a top-level app) or uses the id. */
  slugIsLink: boolean;
  /**
   * Why this person may change the name but not the link, when that is so
   * (someone else's personal folder, or no editing role). The link field
   * shows, disabled, with this reason, and only the name is sent.
   */
  linkLockedReason?: string;
  busy?: boolean;
  /** The server's refusal, shown until the next attempt. */
  error?: string | null;
  onClose: () => void;
  /** Only what changed is passed; both undefined never happens. */
  onConfirm: (change: {
    title?: string;
    slug?: string;
  }) => void | Promise<void>;
}

export function AppRenameDialog({
  open,
  currentTitle,
  currentSlug,
  slugIsLink,
  linkLockedReason,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: AppRenameDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const [slug, setSlug] = useState(currentSlug);
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setSlug(currentSlug);
    }
  }, [open, currentTitle, currentSlug]);

  // The server's rules, in its words (lib/object-name-rules.ts): what it
  // would refuse is refused here as it is typed, and Rename stays off.
  const nextTitle = normalizeObjectName(title);
  const nextSlug = normalizeAppName(slug);
  const titleChanged = nextTitle !== currentTitle;
  const slugChanged = !linkLockedReason && nextSlug !== currentSlug;
  const titleProblem = titleChanged ? appTitleError(title) : null;
  const slugProblem = slugChanged ? appLinkError(slug) : null;
  const canSubmit =
    !busy && !titleProblem && !slugProblem && (titleChanged || slugChanged);

  const submit = () => {
    if (!canSubmit) return;
    void onConfirm({
      ...(titleChanged ? { title: nextTitle } : {}),
      ...(slugChanged ? { slug: nextSlug } : {}),
    });
  };
  const onEnter = (e: { key: string }) => {
    if (e.key === "Enter") submit();
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
          onKeyDown={onEnter}
          error={!!titleProblem}
          helperText={titleProblem ?? " "}
          disabled={busy}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Link"
          value={slug}
          onChange={e => setSlug(e.target.value)}
          onKeyDown={onEnter}
          error={!!slugProblem}
          helperText={
            linkLockedReason ??
            slugProblem ??
            (slugIsLink
              ? `/apps/${nextSlug || currentSlug}`
              : "This app's link uses its id, so the link itself does not change.")
          }
          disabled={busy || !!linkLockedReason}
          slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
        />
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {linkLockedReason
            ? "Only the name can change here."
            : slugIsLink
              ? `If you change the link, the old one (/apps/${currentSlug}) keeps working: it will still open this app.`
              : "If you change the link, the old one keeps working: it will still open this app."}
        </Typography>
        {error && (
          <Typography
            role="alert"
            variant="caption"
            sx={{ display: "block", mt: 1, color: "error.main" }}
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
