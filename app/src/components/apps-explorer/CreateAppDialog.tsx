import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";

interface CreateAppDialogProps {
  open: boolean;
  creating: boolean;
  title: string;
  onTitleChange: (title: string) => void;
  folder: string;
  onFolderChange: (folder: string) => void;
  folderOptions: Array<{ path: string; label: string }>;
  /** The connected repo, named in the hint when there is one. */
  repo?: { owner: string; repo: string };
  onClose: () => void;
  onCreate: () => void;
}

/** "New app": a title and the folder it is created in. */
export function CreateAppDialog({
  open,
  creating,
  title,
  onTitleChange,
  folder,
  onFolderChange,
  folderOptions,
  repo,
  onClose,
  onCreate,
}: CreateAppDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => !creating && onClose()}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>New app</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label="Title"
          value={title}
          onChange={e => onTitleChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") onCreate();
          }}
          disabled={creating}
        />
        <TextField
          select
          fullWidth
          margin="dense"
          label="Folder"
          value={folder}
          onChange={e => onFolderChange(e.target.value)}
          disabled={creating}
          slotProps={{ select: { native: true } }}
        >
          {folderOptions.map(o => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </TextField>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {repo
            ? `Creates a real Vite + React project in the connected GitHub repo (${repo.owner}/${repo.repo}).`
            : "Creates a real Vite + React project in the workspace repo."}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={onCreate}
          disabled={creating || !title.trim()}
        >
          {creating ? "Creating..." : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
