/**
 * One DuckDB memory budget across the app frames on this page.
 *
 * Every app iframe runs its own DuckDB-WASM worker with its own heap (up to
 * 3.1 GiB). The SDK evicts inside its own frame, which does nothing for the next
 * app opened. So each frame (SDK >= 2.13) posts what its heap holds
 * (`mako-app:duckdb-memory`), and when the frames together hold more than the
 * budget, the least recently shown ones are asked to release
 * (`mako-host:duckdb-release`). A frame on screen is never asked.
 *
 * A WASM heap never shrinks, so a release ends that frame's DuckDB worker.
 * The rows it shows stay on screen. Its parquet stays in the frame as Blobs,
 * so the next query there boots a new engine and reloads without a download.
 * A frame that keeps state in its engine says `canRelease: false`. It counts
 * toward the total and is never asked, so the next frame is.
 *
 * What this cannot see: frames on an older SDK, the dev-mode preview, and apps
 * that boot their own DuckDB send no report. They count as nothing and cannot
 * be asked. A report is also a floor: it covers tables and parquet copies, and
 * query scratch stays in the heap unseen (1037 MiB reported, about 1500 MiB
 * measured in the renderer).
 *
 * Messages are only believed from an app frame, checked by the caller with
 * the same source + origin test as `mako-app:navigate` (app-frame.ts).
 */

export const APP_DUCKDB_MEMORY_MESSAGE = "mako-app:duckdb-memory";
export const APP_DUCKDB_RELEASE_MESSAGE = "mako-host:duckdb-release";

/**
 * 2 GiB across all app frames. Up to 4 app tabs stay mounted
 * (APP_TAB_MOUNT_CAP), each allowed 1.5 GiB of tables by the SDK: 6 GiB in
 * one renderer if nothing coordinated. 2 GiB keeps the front app's full
 * budget plus room for one more.
 */
export const APP_DUCKDB_GLOBAL_BUDGET = 2 * 1024 ** 3;

/** A WASM heap's address space. A report past it is not a measurement. */
export const APP_FRAME_MAX_BYTES = 4 * 1024 ** 3;

/** A skipped ask gets no new report on a quiet page, so ask again. */
const RETRY_MS = 10_000;

export interface AppFrameMemory {
  /** What the frame's heap holds, as it last reported. */
  bytes: number;
  /** False: app code keeps state in its engine, so asking frees nothing. */
  canRelease?: boolean;
  /** When the frame was last on screen (ms). */
  shownAt: number;
  /** On screen now: never asked to release. */
  visible: boolean;
}

/**
 * The frames to ask, least recently shown first, until the rest fit in
 * `budget`. Pure, for tests.
 */
export function framesToRelease<K>(
  frames: ReadonlyMap<K, AppFrameMemory>,
  budget: number = APP_DUCKDB_GLOBAL_BUDGET,
): K[] {
  let total = 0;
  for (const f of frames.values()) total += f.bytes;
  if (total <= budget) return [];
  const candidates = [...frames]
    .filter(([, f]) => !f.visible && f.bytes > 0 && f.canRelease !== false)
    .sort(([, a], [, b]) => a.shownAt - b.shownAt);
  const out: K[] = [];
  for (const [key, f] of candidates) {
    if (total <= budget) break;
    out.push(key);
    total -= f.bytes;
  }
  return out;
}

interface LiveFrame extends AppFrameMemory {
  target: Window | null;
  /** `event.origin` of its messages: "null" for an opaque frame. */
  origin: string;
}

const frames = new Map<string, LiveFrame>();

function entry(key: string): LiveFrame {
  let f = frames.get(key);
  if (!f) {
    f = {
      bytes: 0,
      canRelease: true,
      shownAt: 0,
      visible: false,
      target: null,
      origin: "null",
    };
    frames.set(key, f);
  }
  return f;
}

let retry: ReturnType<typeof setTimeout> | null = null;
let queued: ReturnType<typeof setTimeout> | null = null;

function enforce(): void {
  const asked = framesToRelease(frames);
  if (asked.length > 0 && retry === null) {
    retry = setTimeout(() => {
      retry = null;
      enforce();
    }, RETRY_MS);
  }
  for (const key of asked) {
    const f = frames.get(key);
    if (!f?.target) continue;
    try {
      // An opaque frame's origin cannot be named; its window is the target.
      f.target.postMessage(
        { type: APP_DUCKDB_RELEASE_MESSAGE },
        f.origin === "null" ? "*" : f.origin,
      );
    } catch {
      // The frame navigated away or closed: its next report updates it.
    }
  }
}

/** A frame's report. `target` and `origin` come from the verified event. */
export function reportAppFrameMemory(
  key: string,
  target: Window,
  origin: string,
  bytes: number,
  canRelease = true,
): void {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  const f = entry(key);
  f.target = target;
  f.origin = origin;
  f.bytes = Math.min(bytes, APP_FRAME_MAX_BYTES);
  f.canRelease = canRelease;
  if (f.visible) f.shownAt = Date.now();
  enforce();
}

/** The frame's tab came on screen or left it. */
export function setAppFrameVisible(key: string, visible: boolean): void {
  const f = entry(key);
  if (visible || f.visible) f.shownAt = Date.now();
  f.visible = visible;
  // A tab switch is two calls, and the tab going away may come first. Asking
  // between them would release the tab coming on screen.
  queued ??= setTimeout(() => {
    queued = null;
    enforce();
  }, 0);
}

/**
 * The frame's document went away but its tab stays (rebuild, deep link, dev
 * mode). Its heap went with it, and the next document may never report.
 */
export function clearAppFrame(key: string): void {
  const f = frames.get(key);
  if (!f) return;
  f.bytes = 0;
  f.canRelease = true;
  f.target = null;
}

/** The frame unmounted: its worker went with it. */
export function forgetAppFrame(key: string): void {
  frames.delete(key);
}

/** Test-only: forget every frame. */
export function resetAppFrameMemory(): void {
  frames.clear();
  if (retry !== null) clearTimeout(retry);
  if (queued !== null) clearTimeout(queued);
  retry = null;
  queued = null;
}
