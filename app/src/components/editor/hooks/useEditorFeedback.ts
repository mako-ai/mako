import { useCallback, useMemo, useState } from "react";
import type { PreviewRetry } from "../types";

/**
 * The Editor's two feedback surfaces: the "Operation Error" modal (with an
 * optional admin "Execute anyway" retry for a PREVIEW_BLOCKED query) and the
 * success snackbar. Setters are stable so hooks can depend on them freely.
 */
export function useEditorFeedback() {
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [errorPreviewRetry, setErrorPreviewRetry] =
    useState<PreviewRetry | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");

  const showError = useCallback((message: string) => {
    setErrorMessage(message);
    setErrorModalOpen(true);
  }, []);

  const closeError = useCallback(() => {
    setErrorModalOpen(false);
    setErrorMessage("");
    setErrorPreviewRetry(null);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
    setSnackbarOpen(true);
  }, []);

  const hideSnackbar = useCallback(() => {
    setSnackbarOpen(false);
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
    snackbarOpen,
    snackbarMessage,
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
