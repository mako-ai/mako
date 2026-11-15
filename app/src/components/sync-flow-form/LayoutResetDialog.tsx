import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import type { SyncFlowFormModel } from "./useSyncFlowForm";

export function LayoutResetDialog({ model }: { model: SyncFlowFormModel }) {
  const {
    isSubmitting,
    pendingLayoutReset,
    setPendingLayoutReset,
    executeSave,
  } = model;
  return (
    <Dialog
      open={pendingLayoutReset !== null}
      onClose={() => !isSubmitting && setPendingLayoutReset(null)}
    >
      <DialogTitle>Rebuild destination tables?</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          You changed the partition or cluster layout for{" "}
          <strong>{pendingLayoutReset?.entities.join(", ")}</strong>. These
          settings are fixed when a destination table is created, so the
          table(s) must be rebuilt for the change to take effect.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => setPendingLayoutReset(null)}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          color="warning"
          variant="contained"
          disabled={isSubmitting}
          onClick={async () => {
            const pending = pendingLayoutReset;
            if (!pending) return;
            setPendingLayoutReset(null);
            await executeSave(pending.data, {
              resetEntities: pending.entities,
            });
          }}
        >
          {isSubmitting ? "Rebuilding..." : "Save & rebuild tables"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
