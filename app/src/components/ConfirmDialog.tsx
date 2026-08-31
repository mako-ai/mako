import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";

/**
 * The one confirmation primitive.
 *
 * Two ways in:
 * - `<ConfirmDialog>` when the caller owns the busy/loading state (the action
 *   runs while the dialog stays open: buttons disabled, spinner on confirm).
 * - `useConfirm()` for the plain "are you sure?" gate from an event handler:
 *   `if (!(await confirm({ title, body }))) return;` — backed by the one
 *   `<ConfirmProvider>` mounted in main.tsx.
 */

export interface ConfirmOptions {
  title: ReactNode;
  /** A string renders as `DialogContentText`; any other node renders as-is. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the error color. */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  /** Disables both buttons, shows a spinner on confirm, ignores backdrop/escape. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      maxWidth="sm"
      fullWidth
      aria-labelledby="confirm-dialog-title"
    >
      <DialogTitle id="confirm-dialog-title">{title}</DialogTitle>
      {body != null && body !== "" && (
        <DialogContent>
          {typeof body === "string" ? (
            <DialogContentText>{body}</DialogContentText>
          ) : (
            body
          )}
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          onClick={onConfirm}
          color={destructive ? "error" : "primary"}
          variant="contained"
          disableElevation
          disabled={busy}
          startIcon={busy ? <CircularProgress size={14} /> : undefined}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => {
  throw new Error("useConfirm() requires a <ConfirmProvider> above it");
});

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Kept after settle so the dialog fades out with its content intact.
  const [lastOptions, setLastOptions] = useState<ConfirmOptions | null>(null);

  const confirm = useCallback<ConfirmFn>(
    options =>
      new Promise<boolean>(resolve => {
        setLastOptions(options);
        setPending(prev => {
          // A second confirm while one is open supersedes it: the first
          // caller sees "cancelled" rather than hanging forever.
          prev?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    setPending(prev => {
      prev?.resolve(confirmed);
      return null;
    });
  }, []);

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  const options = pending?.options ?? lastOptions;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <ConfirmDialog
          open={pending !== null}
          {...options}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
