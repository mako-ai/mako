/**
 * What a dbt file rename could not fix for you — a config that no longer
 * applies, the old warehouse table, consoles still naming it. These change
 * what the next run builds, so they stay on screen until dismissed (a toast
 * that vanishes in a few seconds was easy to miss). Each warning is one
 * plain sentence; precise detail (the config key, file lists) is secondary.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import { splitRenameWarning } from "../lib/dbt-rename-path";

export interface DbtRenameWarningsProps {
  /** null = closed. */
  warnings: string[] | null;
  /** Where the file went, for the title. */
  renamedTo?: string;
  onClose: () => void;
}

export function DbtRenameWarnings({
  warnings,
  renamedTo,
  onClose,
}: DbtRenameWarningsProps) {
  return (
    <Dialog
      open={warnings !== null && warnings.length > 0}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        {renamedTo ? `Renamed to ${renamedTo} — check these` : "Check these"}
      </DialogTitle>
      <DialogContent>
        {(warnings ?? []).map((warning, i) => {
          const { message, detail } = splitRenameWarning(warning);
          return (
            <Alert key={i} severity="warning" sx={{ mb: 1 }}>
              <AlertTitle sx={{ fontWeight: 400, mb: detail ? 0.5 : 0 }}>
                {message}
              </AlertTitle>
              {detail && (
                <Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {detail}
                  </Typography>
                </Box>
              )}
            </Alert>
          );
        })}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Got it</Button>
      </DialogActions>
    </Dialog>
  );
}

export default DbtRenameWarnings;
