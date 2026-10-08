/**
 * Rename a flow or a dbt job: the display name, and — as a secondary field
 * that defaults to "unchanged" — its file name (slug).
 *
 * Both go through `renameObject` (api/src/rename): the server moves the
 * file and records the old slug as an alias in ONE commit, the object keeps
 * its id, and old links keep resolving. Nothing here re-implements a rename.
 *
 * What the server would refuse for the name itself (length, control or
 * invisible characters, a file name that is not a slug, a Windows device
 * name, an id lookalike) is refused here as it is typed, in the server's
 * words, with the Rename button disabled — the same rules
 * (lib/object-name-rules.ts, pinned to the server's by a parity test). The
 * server still checks; whether the name is free only it can say.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";
import {
  renameObject,
  type ObjectKind,
  type RenameObjectResult,
} from "../lib/object-links";
import {
  normalizeObjectName,
  objectNameError,
  objectSlugError,
} from "../lib/object-name-rules";

export interface RenameObjectDialogTarget {
  kind: Extract<ObjectKind, "flow" | "dbt_job">;
  /** Id (preferred), current slug, or an old slug. */
  ref: string;
  title: string;
  /** Current file name without the directory or `.yml`. */
  slug?: string;
}

interface RenameObjectDialogProps {
  workspaceId: string | undefined;
  target: RenameObjectDialogTarget | null;
  onClose: () => void;
  onRenamed: (result: RenameObjectResult) => void;
}

const FILE_DIR: Record<RenameObjectDialogTarget["kind"], string> = {
  flow: "flows/",
  dbt_job: "dbt/jobs/",
};

export function RenameObjectDialog({
  workspaceId,
  target,
  onClose,
  onRenamed,
}: RenameObjectDialogProps) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setTitle(target.title);
    setSlug(target.slug ?? "");
    setError(null);
    setBusy(false);
  }, [target]);

  // NFC + trimmed, as the server compares: "Café" typed either way is the
  // name it already has.
  const titleChanged = !!target && normalizeObjectName(title) !== target.title;
  const slugChanged =
    !!target &&
    !!target.slug &&
    slug.trim() !== "" &&
    slug.trim() !== target.slug;
  const titleError =
    target && (titleChanged || !title.trim())
      ? objectNameError(target.kind, title)
      : null;
  const slugError =
    target && slugChanged ? objectSlugError(target.kind, slug.trim()) : null;
  const canSubmit =
    !!target &&
    !busy &&
    (titleChanged || slugChanged) &&
    !titleError &&
    !slugError;

  const submit = async () => {
    if (!target || !workspaceId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await renameObject(workspaceId, target.kind, {
        ref: target.ref,
        ...(titleChanged ? { title: normalizeObjectName(title) } : {}),
        ...(slugChanged ? { slug: slug.trim() } : {}),
      });
      onRenamed(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={busy ? undefined : onClose}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>
        Rename {target?.kind === "dbt_job" ? "job" : "flow"}
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Name"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") void submit();
          }}
          error={!!titleError}
          helperText={titleError ?? undefined}
          sx={{ mt: 1 }}
        />
        {target?.slug ? (
          <TextField
            fullWidth
            size="small"
            label="File name"
            value={slug}
            onChange={e => setSlug(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void submit();
            }}
            error={!!slugError}
            helperText={
              slugError ??
              (slugChanged
                ? `${FILE_DIR[target.kind]}${target.slug}.yml → ${FILE_DIR[target.kind]}${slug.trim()}.yml. The old name keeps working.`
                : `${FILE_DIR[target.kind]}${target.slug}.yml — leave as is to keep the file where it is.`)
            }
            sx={{ mt: 2 }}
          />
        ) : null}
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {busy ? "Renaming…" : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
