import { useCallback, useMemo, useState } from "react";
import { notify } from "../../../store/notificationStore";
import type { PreviewRetry } from "../types";

/**
 * The Editor's two feedback surfaces: the "Operation Error" modal (with an
 * optional admin "Execute anyway" retry for a PREVIEW_BLOCKED query) and
 * success toasts (the app-wide notification host: bottom-right, 6s).
 * Setters are stable so hooks can depend on them freely.
 */
export function useEditorFeedback() {
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [errorPreviewRetry, setErrorPreviewRetry] =
    useState<PreviewRetry | null>(null);

  const showError = useCallback((message: string) => {
    setErrorMessage(message);
    setErrorModalOpen(true);
  }, []);

  const closeError = useCallback(() => {
    setErrorModalOpen(false);
    setErrorMessage("");
    setErrorPreviewRetry(null);
  }, []);

  /** Show a success toast; returns its id so it can be dismissed early. */
  const showSnackbar = useCallback(
    (message: string) =>
      notify.success(message, {
        autoHideDuration: 6000,
        anchorOrigin: { vertical: "bottom", horizontal: "right" },
      }),
    [],
  );

  const hideSnackbar = useCallback((toastId: number) => {
    notify.dismiss(toastId);
  }, []);

  const actions = useMemo(
    () => ({
      showError,
      closeError,
      setErrorPreviewRetry,
      showSnackbar,
      hideSnackbar,
    }),
    [showError, closeError, showSnackbar, hideSnackbar],
  );

  return {
    errorModalOpen,
    errorMessage,
    errorPreviewRetry,
    ...actions,
  };
}

export type EditorFeedback = Pick<
  ReturnType<typeof useEditorFeedback>,
  | "showError"
  | "closeError"
  | "setErrorPreviewRetry"
  | "showSnackbar"
  | "hideSnackbar"
>;
