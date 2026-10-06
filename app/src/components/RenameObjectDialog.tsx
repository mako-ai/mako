/**
 * Rename a flow or a dbt job: the display name, and — as a secondary field
 * that defaults to "unchanged" — its file name (slug).
 *
 * Both go through `renameObject` (api/src/rename): the server moves the
 * file and records the old slug as an alias in ONE commit, the object keeps
 * its id, and old links keep resolving. Nothing here re-implements a rename.
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

  const titleChanged = !!target && title.trim() !== target.title;
  const slugChanged =
    !!target &&
    !!target.slug &&
    slug.trim() !== "" &&
    slug.trim() !== target.slug;
  const canSubmit =
    !!target && !busy && title.trim() !== "" && (titleChanged || slugChanged);

  const submit = async () => {
    if (!target || !workspaceId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await renameObject(workspaceId, target.kind, {
        ref: target.ref,
        ...(titleChanged ? { title: title.trim() } : {}),
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
            helperText={
              slugChanged
                ? `${FILE_DIR[target.kind]}${target.slug}.yml → ${FILE_DIR[target.kind]}${slug.trim()}.yml. The old name keeps working.`
                : `${FILE_DIR[target.kind]}${target.slug}.yml — leave as is to keep the file where it is.`
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
