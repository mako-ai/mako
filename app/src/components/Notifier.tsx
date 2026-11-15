import { useEffect, useState } from "react";
import { Alert, Button, IconButton, Snackbar } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useNotificationStore } from "../store/notificationStore";

/**
 * The one toast host: renders the head of the notification queue. Mounted
 * once at the app root; components enqueue through `notify` / `useNotify()`.
 *
 * Follows MUI's "consecutive snackbars" pattern: when a newer toast is
 * waiting, the visible one closes and the next opens after the exit
 * transition, so a quick sequence ("Preparing CSV…" → "CSV downloaded")
 * replaces rather than stacks.
 */
export function Notifier() {
  const current = useNotificationStore(s => s.queue[0]);
  const hasNext = useNotificationStore(s => s.queue.length > 1);
  const remove = useNotificationStore(s => s.remove);
  const [open, setOpen] = useState(false);

  const currentId = current?.id;
  useEffect(() => {
    if (currentId !== undefined) setOpen(true);
  }, [currentId]);

  const closing = current?.closing ?? false;
  useEffect(() => {
    if (hasNext || closing) setOpen(false);
  }, [hasNext, closing]);

  if (!current) return null;

  const actionButton = current.action ? (
    <Button
      color="inherit"
      size="small"
      onClick={() => {
        current.action?.onClick();
        setOpen(false);
      }}
    >
      {current.action.label}
    </Button>
  ) : undefined;

  return (
    <Snackbar
      key={current.id}
      open={open}
      autoHideDuration={current.autoHideDuration}
      onClose={() => setOpen(false)}
      anchorOrigin={current.anchorOrigin}
      slotProps={{ transition: { onExited: () => remove(current.id) } }}
      message={current.severity ? undefined : current.message}
      action={current.severity ? undefined : actionButton}
    >
      {current.severity ? (
        <Alert
          onClose={() => setOpen(false)}
          severity={current.severity}
          variant={current.variant}
          // An explicit action replaces Alert's built-in close button, so
          // render both.
          action={
            actionButton ? (
              <>
                {actionButton}
                <IconButton
                  size="small"
                  color="inherit"
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            ) : undefined
          }
          sx={{ width: "100%" }}
        >
          {current.message}
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}
