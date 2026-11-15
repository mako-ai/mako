import { useEffect, useRef, useState } from "react";
import { Alert, Button, IconButton, Snackbar } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import {
  removeNotification,
  useNotificationStore,
  type NotificationAnchor,
} from "../store/notificationStore";

const DEFAULT_AUTO_HIDE_MS = 4000;
const DEFAULT_ANCHOR: NotificationAnchor = {
  vertical: "bottom",
  horizontal: "left",
};

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
  const [open, setOpen] = useState(false);

  // The id of the head toast that was actually shown. A head that must give
  // way before it was ever shown (a newer toast queued in the same tick, or
  // dismissed as soon as it was added) never runs an exit transition, so it
  // is removed directly — otherwise it would sit at the head of the queue
  // forever and every later toast would stay hidden.
  const shownId = useRef<number | undefined>(undefined);

  const currentId = current?.id;
  const closing = current?.closing ?? false;
  useEffect(() => {
    if (currentId === undefined) return;
    if (hasNext || closing) {
      if (shownId.current === currentId) setOpen(false);
      else removeNotification(currentId);
      return;
    }
    shownId.current = currentId;
    setOpen(true);
  }, [currentId, hasNext, closing]);

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
      autoHideDuration={
        current.autoHideDuration === undefined
          ? DEFAULT_AUTO_HIDE_MS
          : current.autoHideDuration
      }
      onClose={() => setOpen(false)}
      anchorOrigin={current.anchorOrigin ?? DEFAULT_ANCHOR}
      slotProps={{
        transition: { onExited: () => removeNotification(current.id) },
      }}
      message={current.severity ? undefined : current.message}
      action={current.severity ? undefined : actionButton}
    >
      {current.severity ? (
        <Alert
          onClose={() => setOpen(false)}
          severity={current.severity}
          variant={current.variant ?? "standard"}
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
