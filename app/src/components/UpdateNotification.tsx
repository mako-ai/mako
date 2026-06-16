import { Alert, Button, IconButton, Snackbar } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useAppVersionStore } from "../store/appVersionStore";
import { useVersionCheck } from "../hooks/useVersionCheck";

/**
 * Watches for newly deployed frontend builds and shows a non-blocking prompt
 * to reload. Critical for the desktop app, where the window can stay open for
 * days and the loaded bundle silently goes stale.
 */
export function UpdateNotification() {
  useVersionCheck();

  const updateAvailable = useAppVersionStore(state => state.updateAvailable);
  const dismissed = useAppVersionStore(state => state.dismissed);
  const dismiss = useAppVersionStore(state => state.dismiss);
  const reloadToUpdate = useAppVersionStore(state => state.reloadToUpdate);

  return (
    <Snackbar
      open={updateAvailable && !dismissed}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    >
      <Alert
        severity="info"
        variant="filled"
        action={
          <>
            <Button color="inherit" size="small" onClick={reloadToUpdate}>
              Reload
            </Button>
            <IconButton
              size="small"
              color="inherit"
              aria-label="Dismiss update notification"
              onClick={dismiss}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      >
        A new version of Mako is available.
      </Alert>
    </Snackbar>
  );
}
