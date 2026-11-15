import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

/**
 * App-wide toast queue. Components call `notify.*` (or `useNotify()`); the
 * single `<Notifier/>` mounted at the app root renders the head of the queue
 * (and applies the display defaults below).
 *
 * Semantics (what the per-component Snackbars used to do, made shared):
 * - One toast is visible at a time. A newer toast replaces the visible one
 *   (the visible one closes, then the next opens), like the old
 *   "one snackbar state per component" pattern.
 * - An identical toast (same `key`, defaulting to severity + message) that is
 *   already visible or waiting is not queued twice.
 * - `autoHideDuration: null` keeps a toast until it is dismissed.
 *
 * This module sits in the entry chunk (entry components raise toasts), so it
 * stays small; rendering lives in the lazily loaded Notifier.
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
  /** ms before the toast hides itself (default 4000); `null` = stays. */
  autoHideDuration?: number | null;
  /** Default bottom-left. */
  anchorOrigin?: NotificationAnchor;
  /** Alert variant for severity toasts (default "standard"). */
  variant?: "standard" | "filled" | "outlined";
  action?: NotificationAction;
  /** Dedupe key; defaults to `${severity}:${message}`. */
  key?: string;
}

export interface Notification extends NotifyOptions {
  id: number;
  key: string;
  message: string;
  /** Absent = plain Snackbar message (no Alert, no close button). */
  severity?: NotificationSeverity;
  /** Set by `dismiss` on the visible toast so the host can animate it out. */
  closing?: boolean;
}

interface NotificationState {
  queue: Notification[];
}

export const useNotificationStore = create<NotificationState>()(
  immer(() => ({ queue: [] as Notification[] })),
);

const { getState, setState } = useNotificationStore;
let nextId = 1;

const enqueue =
  (severity?: NotificationSeverity) =>
  (message: string, options: NotifyOptions = {}): number => {
    const key = options.key ?? `${severity}:${message}`;
    const existing = getState().queue.find(n => n.key === key && !n.closing);
    if (existing) return existing.id;
    const id = nextId++;
    setState(state => {
      state.queue.push({ ...options, id, key, message, severity });
    });
    return id;
  };

/** Close a toast: animated out if visible, dropped if still waiting. */
function dismiss(id: number) {
  setState(state => {
    const index = state.queue.findIndex(n => n.id === id);
    if (index === 0) state.queue[0].closing = true;
    else if (index > 0) state.queue.splice(index, 1);
  });
}

/** Drop a toast from the queue outright (the host calls this on exit). */
export function removeNotification(id: number) {
  setState(state => {
    state.queue = state.queue.filter(n => n.id !== id);
  });
}

/**
 * Imperative API, usable from components, hooks and stores alike. Each call
 * returns the toast id, which `dismiss` accepts.
 */
export const notify = {
  success: enqueue("success"),
  error: enqueue("error"),
  info: enqueue("info"),
  warning: enqueue("warning"),
  /** A plain snackbar message, without an Alert or close button. */
  message: enqueue(),
  dismiss,
};

export type Notify = typeof notify;

/** Hook form of `notify` (a stable object; safe in effect deps). */
export function useNotify(): Notify {
  return notify;
}
