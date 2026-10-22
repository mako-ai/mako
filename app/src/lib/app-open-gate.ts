/**
 * Boot-time background reads wait for the app being opened.
 *
 * Opening /apps/<slug> cold fired about 38 API calls from ~0.8 s, several
 * of them git- or sandbox-backed and slow on prod (repo/status 5.1 s,
 * dev-servers 4.8 s, the app's status 3.7 s, branches 3.4 s). On 1-vCPU
 * Cloud Run instances they queued in front of the two requests the person
 * was actually waiting on: the view token and the app's own files. None of
 * them is on screen until later, so they start once the app has loaded, or
 * after FALLBACK_MS, whichever is first. Any other page opens ungated.
 *
 * Browser-local by nature: one page load's own ordering, no server state.
 */
import { TAB_DEEP_LINK_PATTERNS } from "./tab-routing";

/** Never hold background reads longer than this, loaded or not. */
export const APP_OPEN_FALLBACK_MS = 4_000;

let settled = true;
let waiters: Array<() => void> = [];
let fallback: ReturnType<typeof setTimeout> | undefined;

/** Release everything waiting; later waits resolve at once. */
export function settleAppOpen(): void {
  if (fallback !== undefined) clearTimeout(fallback);
  fallback = undefined;
  if (settled) return;
  settled = true;
  const ready = waiters;
  waiters = [];
  for (const resolve of ready) resolve();
}

/**
 * Hold background reads if this page load opens an app. Called once at
 * module load with the address the page booted on; exported for tests.
 */
export function armAppOpenGate(pathname: string): void {
  if (!TAB_DEEP_LINK_PATTERNS.app.test(pathname)) {
    settleAppOpen();
    return;
  }
  settled = false;
  if (fallback !== undefined) clearTimeout(fallback);
  fallback = setTimeout(settleAppOpen, APP_OPEN_FALLBACK_MS);
}

/** Resolves once the app being opened has loaded (or the fallback fired). */
export function whenAppOpenSettled(): Promise<void> {
  if (settled) return Promise.resolve();
  return new Promise(resolve => waiters.push(resolve));
}

/**
 * Whether an app tab may start its git- and sandbox-backed reads (files,
 * status, branches, the dev-server probe). The front tab only; and while its
 * published app is still loading, not until it has (or `waitOver`, the
 * fallback, fired). Nothing loading — the workbench, an unpublished app, a
 * dev server already serving — means at once.
 */
export function appTabReadsReady(input: {
  isFrontTab: boolean;
  appKnown: boolean;
  awaitingPublishedPaint: boolean;
  waitOver: boolean;
}): boolean {
  return (
    input.isFrontTab &&
    input.appKnown &&
    (!input.awaitingPublishedPaint || input.waitOver)
  );
}

/** The published view is on screen and its frame has not loaded yet. */
export function isAwaitingPublishedPaint(input: {
  editing: boolean;
  publishedSha: string | undefined;
  pubLoaded: boolean;
  devRunning: boolean;
}): boolean {
  return (
    !input.editing &&
    !!input.publishedSha &&
    !input.pubLoaded &&
    !input.devRunning
  );
}

if (typeof window !== "undefined") armAppOpenGate(window.location.pathname);
