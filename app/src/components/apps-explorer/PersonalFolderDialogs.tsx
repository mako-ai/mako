/**
 * The two small dialogs behind personal folders — New folder and Rename —
 * kept out of AppsExplorer, which is already large. Fully controlled: the
 * explorer owns the state and the store calls; this only renders.
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";

export interface RenameTarget {
  id: string;
  name: string;
}

interface PersonalFolderDialogsProps {
  newFolderOpen: boolean;
  folderName: string;
  onFolderNameChange: (name: string) => void;
  onCloseNewFolder: () => void;
  onCreateFolder: () => void;

  renameTarget: RenameTarget | null;
  onRenameTargetChange: (target: RenameTarget | null) => void;
  onRenameFolder: () => void;
}

export default function PersonalFolderDialogs({
  newFolderOpen,
  folderName,
  onFolderNameChange,
  onCloseNewFolder,
  onCreateFolder,
  renameTarget,
  onRenameTargetChange,
  onRenameFolder,
}: PersonalFolderDialogsProps) {
  return (
    <>
      <Dialog
        open={newFolderOpen}
        onClose={onCloseNewFolder}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New folder</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Folder name"
            value={folderName}
            onChange={e => onFolderNameChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onCreateFolder();
            }}
          />
          <Typography variant="caption" color="text.secondary">
            Only you can see this folder. Drag apps into it to tidy your list —
            they move here in your view only. Nothing about the app itself
            changes, and no one else sees a difference.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCloseNewFolder}>Cancel</Button>
          <Button
            variant="contained"
            onClick={onCreateFolder}
            disabled={!folderName.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={!!renameTarget}
        onClose={() => onRenameTargetChange(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Rename folder</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Folder name"
            value={renameTarget?.name ?? ""}
            onChange={e =>
              onRenameTargetChange(
                renameTarget ? { ...renameTarget, name: e.target.value } : null,
              )
            }
            onKeyDown={e => {
              if (e.key === "Enter") onRenameFolder();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => onRenameTargetChange(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={onRenameFolder}
            disabled={!renameTarget?.name.trim()}
          >
            Rename
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
