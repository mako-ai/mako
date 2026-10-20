/**
 * Where on the Apps home an app was opened from — a card's shelf and
 * position — handed from the click to the usage beacon's `open`, so
 * click-through per position can later be computed from the raw usage log
 * (app_usage_events.placement). One pending placement per app, short-lived:
 * a click that never leads to a published view (an unpublished app, a tab
 * that was already open) must not be credited to a later, unrelated open.
 */
export type AppOpenShelf =
  | "popular"
  | "new"
  | "recommended"
  | "recent"
  | "mine"
  | "attention"
  | "search";

export interface AppOpenPlacement {
  surface: "home";
  shelf: AppOpenShelf;
  position: number;
}

/** A click older than this is not the reason for an open. */
export const PLACEMENT_TTL_MS = 2 * 60_000;

const pending = new Map<string, { placement: AppOpenPlacement; at: number }>();

export function notePlacement(
  appId: string,
  placement: AppOpenPlacement,
  now = Date.now(),
): void {
  pending.set(appId, { placement, at: now });
}

/** The placement of a recent click on this app, consumed (once). */
export function takePlacement(
  appId: string,
  now = Date.now(),
): AppOpenPlacement | undefined {
  const hit = pending.get(appId);
  pending.delete(appId);
  if (!hit || now - hit.at > PLACEMENT_TTL_MS) return undefined;
  return hit.placement;
}
