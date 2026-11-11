/**
 * Rename a flow or a dbt job: its name and, as a second field that starts
 * unchanged, its file name.
 *
 * Both go through the rename service (`renameObject`): the server moves
 * the file, keeps the old file name as an alias, and the object keeps its
 * id. What the server would refuse about the name itself is refused here
 * as it is typed, in the server's words (lib/object-name-rules.ts), with
 * the Rename button disabled. So is a file name another object in the
 * list already has (`others`), in the server's words too. The server stays
 * the authority (an old name another object still answers to is only known
 * there); its refusal is shown as it is, until the fields are edited.
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
import { renameObject, type RenameObjectResult } from "../lib/object-links";
import {
  OBJECT_NAME_MAX_LENGTH,
  normalizeObjectName,
  objectNameError,
  objectSlugError,
  type SlugNamedKind,
} from "../lib/object-name-rules";

export interface RenameObjectDialogTarget {
  kind: SlugNamedKind;
  /** The object's id. */
  ref: string;
  title: string;
  /** Current file name, without the folder or `.yml`. */
  slug?: string;
  /** The other objects of this kind the list holds: their file names are taken. */
  others?: ReadonlyArray<{ slug?: string | null; title: string }>;
}

interface RenameObjectDialogProps {
  workspaceId: string | undefined;
  target: RenameObjectDialogTarget | null;
  onClose: () => void;
  onRenamed: (result: RenameObjectResult) => void;
}

const FOLDER: Record<SlugNamedKind, string> = {
  flow: "flows/",
  dbt_job: "dbt/jobs/",
};
/** As the server says it (api/src/rename/slug-files.ts `noun`). */
const NOUN: Record<SlugNamedKind, string> = {
  flow: "flow",
  dbt_job: "dbt job",
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

  // Compared as the server compares: "Café" typed either way is one name.
  const titleChanged = !!target && normalizeObjectName(title) !== target.title;
  const slugChanged =
    !!target?.slug && slug.trim() !== "" && slug.trim() !== target.slug;
  const titleError =
    target && (titleChanged || !title.trim())
      ? objectNameError(title, OBJECT_NAME_MAX_LENGTH[target.kind])
      : null;
  const holder =
    slugChanged && target?.others?.find(other => other.slug === slug.trim());
  const slugError =
    target && slugChanged
      ? (objectSlugError(target.kind, slug) ??
        (holder
          ? `"${slug.trim()}" is already the file name of ${NOUN[target.kind]} "${holder.title}".`
          : null))
      : null;
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
  // A refusal answered what was typed then: it goes once that changes.
  const edit = (set: (value: string) => void, value: string) => {
    set(value);
    setError(null);
  };
  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") void submit();
  };
  const folder = target ? FOLDER[target.kind] : "";

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
          onChange={e => edit(setTitle, e.target.value)}
          onKeyDown={submitOnEnter}
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
            onChange={e => edit(setSlug, e.target.value)}
            onKeyDown={submitOnEnter}
            error={!!slugError}
            helperText={
              slugError ??
              (slugChanged
                ? `${folder}${target.slug}.yml moves to ${folder}${slug.trim()}.yml. The old name keeps working.`
                : `${folder}${target.slug}.yml. Leave it to keep the file where it is.`)
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
