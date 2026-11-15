import {
  Box,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Checkbox,
  FormControlLabel,
} from "@mui/material";
import { ConfirmDialog } from "../ConfirmDialog";
import { entityLabel } from "./backfill-helpers";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillDialogs({ model }: { model: BackfillPanelModel }) {
  const {
    busy,
    resyncOpen,
    setResyncOpen,
    resyncConfirm,
    setResyncConfirm,
    resyncOpts,
    setResyncOpts,
    entityResetOpen,
    setEntityResetOpen,
    entityResetEntity,
    handleResync,
    handleResetEntityTable,
  } = model;
  return (
    <>
      {/* Reset entity table dialog */}
      <ConfirmDialog
        open={entityResetOpen}
        title="Reset table and rebackfill"
        body={
          <Box sx={{ display: "grid", gap: 1 }}>
            <Typography variant="body2">
              Entity:{" "}
              <Box
                component="span"
                sx={{ fontFamily: "monospace", fontWeight: 600 }}
              >
                {entityResetEntity ? entityLabel(entityResetEntity) : "—"}
              </Box>
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              This drops the destination table for this entity, clears its CDC
              state, and starts a fresh backfill.
            </Typography>
          </Box>
        }
        confirmLabel="Reset + rebackfill"
        destructive
        busy={busy}
        onConfirm={() => void handleResetEntityTable()}
        onCancel={() => setEntityResetOpen(false)}
      />

      {/* Reset dialog */}
      <Dialog open={resyncOpen} onClose={() => setResyncOpen(false)}>
        <DialogTitle>Reset sync</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 1, minWidth: 400 }}>
          <Typography variant="body2">
            This will clear all CDC state and restart a full backfill.
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.deleteDestination}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    deleteDestination: e.target.checked,
                  }))
                }
              />
            }
            label="Delete destination tables"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.clearWebhookEvents}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    clearWebhookEvents: e.target.checked,
                  }))
                }
              />
            }
            label="Clear stored webhook events"
          />
          <TextField
            label="Type RESET to confirm"
            value={resyncConfirm}
            onChange={e => setResyncConfirm(e.target.value)}
            size="small"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResyncOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={resyncConfirm !== "RESET" || busy}
            onClick={handleResync}
          >
            {busy ? "Resetting…" : "Reset sync"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
