import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

/**
 * App-wide toast queue. Components call `notify.*` (or `useNotify()`); the
 * single `<Notifier/>` mounted at the app root renders the head of the queue.
 *
 * Semantics (what the per-component Snackbars used to do, made shared):
 * - One toast is visible at a time. A newer toast replaces the visible one
 *   (the visible one closes, then the next opens), like the old
 *   "one snackbar state per component" pattern.
 * - An identical toast (same `key`, defaulting to severity + message) that is
 *   already visible or waiting is not queued twice.
 * - `autoHideDuration: null` keeps a toast until it is dismissed.
 */

export type NotificationSeverity = "success" | "error" | "info" | "warning";

export interface NotificationAnchor {
  vertical: "top" | "bottom";
  horizontal: "left" | "center" | "right";
}

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotifyOptions {
  /** ms before the toast hides itself; `null` = stays until dismissed. */
  autoHideDuration?: number | null;
  anchorOrigin?: NotificationAnchor;
  /** Alert variant for severity toasts (ignored by plain messages). */
  variant?: "standard" | "filled" | "outlined";
  action?: NotificationAction;
  /** Dedupe key; defaults to `${severity}:${message}`. */
  key?: string;
}

export interface Notification {
  id: number;
  key: string;
  message: string;
  /** Absent = plain Snackbar message (no Alert, no close button). */
  severity?: NotificationSeverity;
  autoHideDuration: number | null;
  anchorOrigin: NotificationAnchor;
  variant: "standard" | "filled" | "outlined";
  action?: NotificationAction;
  /** Set by `dismiss` on the visible toast so the host can animate it out. */
  closing: boolean;
}

export const DEFAULT_AUTO_HIDE_MS = 4000;
export const DEFAULT_ANCHOR: NotificationAnchor = {
  vertical: "bottom",
  horizontal: "left",
};

interface NotificationState {
  queue: Notification[];
  enqueue: (
    message: string,
    severity: NotificationSeverity | undefined,
    options?: NotifyOptions,
  ) => number;
  /** Close a toast (animated if visible, dropped if still waiting). */
  dismiss: (id: number) => void;
  /** Drop a toast from the queue outright (the host calls this on exit). */
  remove: (id: number) => void;
}

let nextId = 1;

export const useNotificationStore = create<NotificationState>()(
  immer((set, get) => ({
    queue: [],

    enqueue: (message, severity, options = {}) => {
      const key = options.key ?? `${severity ?? "message"}:${message}`;
      const existing = get().queue.find(n => n.key === key && !n.closing);
      if (existing) return existing.id;

      const id = nextId++;
      set(state => {
        state.queue.push({
          id,
          key,
          message,
          severity,
          autoHideDuration:
            options.autoHideDuration === undefined
              ? DEFAULT_AUTO_HIDE_MS
              : options.autoHideDuration,
          anchorOrigin: options.anchorOrigin ?? DEFAULT_ANCHOR,
          variant: options.variant ?? "standard",
          action: options.action,
          closing: false,
        });
      });
      return id;
    },

    dismiss: id => {
      set(state => {
        const index = state.queue.findIndex(n => n.id === id);
        if (index === -1) return;
        if (index === 0) state.queue[0].closing = true;
        else state.queue.splice(index, 1);
      });
    },

    remove: id => {
      set(state => {
        state.queue = state.queue.filter(n => n.id !== id);
      });
    },
  })),
);

const enqueue = (
  severity: NotificationSeverity | undefined,
  message: string,
  options?: NotifyOptions,
) => useNotificationStore.getState().enqueue(message, severity, options);

/**
 * Imperative API, usable from components, hooks and stores alike. Each call
 * returns the toast id, which `dismiss` accepts.
 */
export const notify = {
  success: (message: string, options?: NotifyOptions) =>
    enqueue("success", message, options),
  error: (message: string, options?: NotifyOptions) =>
    enqueue("error", message, options),
  info: (message: string, options?: NotifyOptions) =>
    enqueue("info", message, options),
  warning: (message: string, options?: NotifyOptions) =>
    enqueue("warning", message, options),
  /** A plain snackbar message, without an Alert or close button. */
  message: (message: string, options?: NotifyOptions) =>
    enqueue(undefined, message, options),
  dismiss: (id: number) => useNotificationStore.getState().dismiss(id),
};

export type Notify = typeof notify;

/** Hook form of `notify` (a stable object; safe in effect deps). */
export function useNotify(): Notify {
  return notify;
}
