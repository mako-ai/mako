import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { ConsoleEntry, ConsoleAccessLevel } from "../store/consoleTreeStore";
import { useWorkspace } from "../contexts/workspace-context";

interface FolderInfoModalProps {
  open: boolean;
  onClose: () => void;
  folder: ConsoleEntry | null;
}

const accessLabels: Record<ConsoleAccessLevel, string> = {
  private: "Private",
  workspace: "Shared with workspace",
};

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FolderInfoModal({
  open,
  onClose,
  folder,
}: FolderInfoModalProps) {
  const { members } = useWorkspace();

  const membersLookup = new Map<string, string>();
  for (const m of members) {
    membersLookup.set(m.userId, m.email);
  }

  const access: ConsoleAccessLevel = folder?.access || "private";
  const ownerName = folder?.owner_id
    ? membersLookup.get(folder.owner_id) || folder.owner_id
    : "Unknown";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Folder Information</DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Name
            </Typography>
            <Typography variant="body2">{folder?.name ?? "—"}</Typography>
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Created by
            </Typography>
            <Typography variant="body2">{ownerName}</Typography>
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Created at
            </Typography>
            <Typography variant="body2">
              {formatDate(folder?.createdAt)}
            </Typography>
          </Box>

          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Access
            </Typography>
            <Chip
              label={accessLabels[access] || access}
              size="small"
              variant="outlined"
            />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
