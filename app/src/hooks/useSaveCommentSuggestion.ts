import { useCallback, useRef, useState } from "react";

export interface SaveCommentSuggestionResult {
  comment: string | null;
  diff: string | null;
}

/**
 * Shared state machine for the AI-suggested commit message in save-version
 * dialogs (consoles, dashboards, apps). Encapsulates the abort-on-reopen
 * controller, the loading flag, and the suggested comment + diff pair so each
 * entity's save dialog only supplies a fetcher for its version-comment
 * endpoint.
 */
export function useSaveCommentSuggestion() {
  const [comment, setComment] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Start a new suggestion cycle (call when the dialog opens). If
   * `initialComment` is provided (e.g. comments already attached to recent AI
   * edits), it is used directly and no request is made. Otherwise `fetcher`
   * is invoked with an abort signal; a subsequent `begin`/`cancel` aborts it.
   */
  const begin = useCallback(
    (
      fetcher?: (signal: AbortSignal) => Promise<SaveCommentSuggestionResult>,
      initialComment?: string,
    ) => {
      abortRef.current?.abort();
      setComment(initialComment);
      setDiff(null);
      if (initialComment || !fetcher) {
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      void fetcher(controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setComment(result.comment ?? undefined);
        setDiff(result.diff);
        setLoading(false);
      });
    },
    [],
  );

  /** Abort any in-flight request and reset (call on dialog close/confirm). */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setDiff(null);
  }, []);

  return { comment, diff, loading, begin, cancel };
}
