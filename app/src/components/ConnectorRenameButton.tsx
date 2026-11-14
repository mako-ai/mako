/**
 * "Rename…" for a workspace connector: the folder `connectors/<slug>/` in
 * the workspace repo and, with it, the connector's type id `ws:<slug>`.
 * Not a connection made with it, and not the connector's display name,
 * which is `name` in the connector's own code: the dialog says so, because
 * the name people see in lists does not change.
 *
 * The slug is checked as it is typed with the server's own rule
 * (`@mako/schemas`, through lib/object-name-rules). Whether the name is
 * free is the server's answer: its sentence is shown as it is, and cleared
 * when the slug is edited. Offered to the people the server lets rename
 * (workspace editors); for anyone else the button is disabled and says why.
 */
import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  Tooltip,
} from "@mui/material";
import { Pencil as PencilIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  CONNECTOR_RENAME_REFUSAL,
  canRenameConnector,
} from "../lib/connector-rename";
import { connectorSlugProblem } from "../lib/object-name-rules";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

export function ConnectorRenameButton({
  slug,
  displayName,
  onRenamed,
}: {
  /** The connector's current folder slug (its type without `ws:`). */
  slug: string;
  /** The name the connector's code declares, shown in lists. */
  displayName?: string;
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
  if (!currentWorkspace) return null;
  const allowed = canRenameConnector(currentWorkspace.role);

  const next = value.trim();
  const problem = next && next !== slug ? connectorSlugProblem(next) : null;
  const ready = next !== "" && next !== slug && !problem && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // The dialog is rendered inside the connection form: React bubbles its
    // submit to that form, which would save the connection too.
    event.stopPropagation();
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
      <Tooltip title={allowed ? "" : CONNECTOR_RENAME_REFUSAL}>
        {/* The span keeps the tooltip working on a disabled button. */}
        <span>
          <Button
            size="small"
            disabled={!allowed}
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
        </span>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => !saving && setOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <form onSubmit={submit}>
          <DialogTitle>Rename connector folder</DialogTitle>
          <DialogContent>
            <DialogContentText variant="body2" sx={{ mb: 1 }}>
              This renames the connector&apos;s folder in the workspace repo,
              connectors/{slug}/, and with it the connector&apos;s type id, ws:
              {slug}. Its connections keep working, and &quot;{slug}&quot; keeps
              naming it.
            </DialogContentText>
            <DialogContentText variant="body2" sx={{ mb: 1 }}>
              It does not change the display name
              {displayName ? ` "${displayName}"` : ""} shown in lists: that is{" "}
              <code>name</code> in the connector&apos;s code (
              <code>defineConnector</code> in its entry file). Change it there.
            </DialogContentText>
            <TextField
              autoFocus
              fullWidth
              margin="dense"
              label="Folder slug"
              value={value}
              onChange={event => {
                setValue(event.target.value);
                setRefusal(null);
              }}
              error={Boolean(problem || refusal)}
              helperText={problem ?? refusal ?? `Type id: ws:${next || slug}`}
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
