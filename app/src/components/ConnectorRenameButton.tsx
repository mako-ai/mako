/**
 * "Rename…" for a workspace connector: the folder `connectors/<slug>/` in
 * the workspace repo, not a connection made with it. The connector keeps
 * its id and its connections (they move from `ws:<old>` to `ws:<new>`), and
 * its old slug keeps naming it.
 *
 * The slug is checked as it is typed with the server's own rule
 * (`@mako/schemas`, through lib/object-name-rules). Whether the name is
 * free is the server's answer: its sentence is shown as it is, and cleared
 * when the slug is edited.
 */
import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";
import { Pencil as PencilIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { connectorSlugProblem } from "../lib/object-name-rules";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

export function ConnectorRenameButton({
  slug,
  onRenamed,
}: {
  /** The connector's current folder slug (its type without `ws:`). */
  slug: string;
  /** Called with the new slug once the server has renamed the connector. */
  onRenamed: (slug: string) => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const rename = useConnectorCatalogStore(
    state => state.renameWorkspaceConnector,
  );
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(slug);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Renaming is a write to the workspace repo: not offered to viewers.
  if (!currentWorkspace || currentWorkspace.role === "viewer") return null;

  const next = value.trim();
  const problem = next && next !== slug ? connectorSlugProblem(next) : null;
  const ready = next !== "" && next !== slug && !problem && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setRefusal(null);
    const outcome = await rename(currentWorkspace.id, slug, next);
    setSaving(false);
    if ("error" in outcome) {
      setRefusal(outcome.error);
      return;
    }
    setOpen(false);
    onRenamed(outcome.slug);
  };

  return (
    <>
      <Button
        size="small"
        startIcon={<PencilIcon size={16} />}
        onClick={() => {
          setValue(slug);
          setRefusal(null);
          setOpen(true);
        }}
        sx={{ textTransform: "none", fontSize: "0.75rem" }}
      >
        Rename…
      </Button>
      <Dialog
        open={open}
        onClose={() => !saving && setOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <form onSubmit={submit}>
          <DialogTitle>Rename connector</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              margin="dense"
              label="Connector slug"
              value={value}
              onChange={event => {
                setValue(event.target.value);
                setRefusal(null);
              }}
              error={Boolean(problem || refusal)}
              helperText={
                problem ??
                refusal ??
                `Moves connectors/${slug}/ in the workspace repo. The connector keeps its connections, and "${slug}" keeps naming it.`
              }
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={!ready}>
              {saving ? "Renaming…" : "Rename"}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}
