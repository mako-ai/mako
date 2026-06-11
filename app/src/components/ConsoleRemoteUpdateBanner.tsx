/**
 * Non-blocking affordance shown when a console changed on the server while
 * this tab holds unsaved local edits (or was deleted remotely). Never merges
 * silently — the user chooses to load the latest copy or keep editing (the
 * explicit save's version guard still backstops a stale overwrite).
 */
import { Alert, Button, Stack } from "@mui/material";
import type { ConsoleTab } from "../store/lib/types";

interface ConsoleRemoteUpdateBannerProps {
  remoteUpdate: NonNullable<ConsoleTab["remoteUpdate"]>;
  onLoadLatest: () => void;
  /** Deliberately overwrite the server copy with this tab's content. */
  onKeepMine?: () => void;
  onDismiss: () => void;
  onCloseTab: () => void;
}

export default function ConsoleRemoteUpdateBanner({
  remoteUpdate,
  onLoadLatest,
  onKeepMine,
  onDismiss,
  onCloseTab,
}: ConsoleRemoteUpdateBannerProps) {
  const isDeleted = remoteUpdate.kind === "deleted";
  const who = remoteUpdate.updatedBy ? "another collaborator" : "elsewhere";

  return (
    <Alert
      severity={isDeleted ? "warning" : "info"}
      sx={{ borderRadius: 0, py: 0.25, alignItems: "center" }}
      action={
        <Stack direction="row" spacing={1} alignItems="center">
          {isDeleted ? (
            <Button color="inherit" size="small" onClick={onCloseTab}>
              Close tab
            </Button>
          ) : (
            <>
              <Button color="inherit" size="small" onClick={onLoadLatest}>
                Load latest
              </Button>
              {onKeepMine && (
                <Button color="inherit" size="small" onClick={onKeepMine}>
                  Keep mine
                </Button>
              )}
            </>
          )}
          <Button color="inherit" size="small" onClick={onDismiss}>
            Dismiss
          </Button>
        </Stack>
      }
    >
      {isDeleted
        ? "This console was deleted by another user."
        : `This console was updated ${who} — your unsaved changes are based on an older copy.`}
    </Alert>
  );
}
