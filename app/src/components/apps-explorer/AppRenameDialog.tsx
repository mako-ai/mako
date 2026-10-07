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
import {
  appLinkError,
  appNameError,
  normalizeAppName,
} from "../../lib/object-name-rules";

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
  /**
   * Why this person may change the NAME but not the LINK, when that is so
   * (appRenameRights `title`: someone else's personal folder, shared with
   * them as an editor). The link field shows, disabled, with this reason;
   * only the name is ever sent.
   */
  linkLockedReason?: string;
  /**
   * Whether the app has a published deployment. A rename rewrites
   * mako.json, and deploy-on-push republishes a published app once for
   * it; an app never published has nothing to republish, so it is not
   * told it will be.
   */
  published?: boolean;
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
  linkLockedReason,
  published = false,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: AppRenameDialogProps) {
  const linkLocked = !!linkLockedReason;
  const initialSlug = linkLocked ? currentSlug : (prefillSlug ?? currentSlug);
  const [title, setTitle] = useState(currentTitle);
  const [slug, setSlug] = useState(initialSlug);
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setSlug(initialSlug);
    }
  }, [open, currentTitle, initialSlug]);

  // The server's rules, in its words (lib/object-name-rules.ts, pinned to
  // the API by name-rules-parity.test.ts): a link or name it would refuse
  // is refused here as it is typed, and Rename stays off.
  const nextTitle = normalizeAppName(title);
  const nextSlug = normalizeAppName(slug);
  const titleChanged = nextTitle !== currentTitle && nextTitle !== "";
  const slugChanged = !linkLocked && nextSlug !== currentSlug;
  const titleProblem = appNameError(title);
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
  const oldLink = slugIsLink ? `/apps/${currentSlug}` : "The old link";

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
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          error={!!slugProblem}
          helperText={
            linkLockedReason ??
            slugProblem ??
            (slugIsLink
              ? `/apps/${nextSlug || currentSlug}`
              : "The app's folder name. Its link uses the app's id, so the link itself does not change.")
          }
          disabled={busy || linkLocked}
          slotProps={{ input: { sx: { fontFamily: "monospace" } } }}
        />
        <Typography variant="caption" color="text.secondary">
          {[
            linkLocked
              ? "Only the name can change here."
              : slugChanged
                ? `${oldLink} keeps working: it will still open this app. If another app used that name before, that app stops answering to it — you'll be told.`
                : `If you change the link, ${slugIsLink ? `the old one (${oldLink})` : "the old one"} keeps working — it will still open this app.`,
            published
              ? "A change rewrites mako.json, which republishes the app once."
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
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
