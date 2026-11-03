/**
 * What a pending `__data/<name>.parquet` (or `POST __data/<name>/refresh`)
 * is waiting on, told on the SAME connection.
 *
 * The SDK used to see one opaque wait: a GET that might be a warehouse
 * rebuild of several minutes or a 200 ms signed-URL lookup. A client that
 * sends `Accept: application/x-ndjson` now gets a stream of phase events
 * instead, one JSON object per line, ending in exactly one terminal event:
 *
 *   {"phase":"checking"}
 *   {"phase":"querying_warehouse"}
 *   {"phase":"writing_parquet","rowsWritten":120000}
 *   {"phase":"uploading","rowsWritten":149210,"bytes":10485760}
 *   {"phase":"ready", ...the route's normal JSON answer...}
 * or
 *   {"phase":"failed","status":502,"error":"…"}
 *
 * A GET of a stored artifact streams `resolving` → `signing` → `ready` with
 * the signed `url` the 302 would have carried (fetch follows a redirect
 * without exposing it, so a header on the 302 could never reach the page).
 * Clients without that Accept header get today's answers, byte for byte.
 *
 * No shared state: the events are produced by the request doing the work
 * and written to that request's response. Builders deep in the stack report
 * through an AsyncLocalStorage, the same way query labels reach the
 * warehouse driver, so nothing threads a callback through every layer. The
 * one cross-request case — a refresh joining a build already in flight —
 * subscribes to that build's hub (binding-refresh.ts), which lives exactly
 * as long as the promise both callers already share.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import type { ArtifactStore } from "../services/artifact-store.service";
import {
  signArtifactUrl,
  artifactDeliveryMode,
} from "../services/artifact-delivery.service";
import { loggers } from "../logging";

const logger = loggers.api("apps");

export const BINDING_PROGRESS_CONTENT_TYPE = "application/x-ndjson";

/** Server-side phases, in the order a full rebuild passes through them. */
export type BindingPhase =
  | "queued"
  | "checking"
  | "querying_warehouse"
  | "writing_parquet"
  | "uploading"
  | "resolving"
  | "signing";

export interface BindingProgressEvent {
  phase: BindingPhase;
  rowsWritten?: number;
  bytes?: number;
}

export type BindingProgressListener = (event: BindingProgressEvent) => void;

const storage = new AsyncLocalStorage<BindingProgressListener>();

/** Run `fn` with `listener` receiving every phase reported inside it. */
export function withBindingProgress<T>(
  listener: BindingProgressListener,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(listener, fn);
}

/** Tell whoever is listening (nobody, most of the time) what is happening. */
export function reportBindingPhase(
  phase: BindingPhase,
  extra: Omit<BindingProgressEvent, "phase"> = {},
): void {
  const listener = storage.getStore();
  if (!listener) return;
  try {
    listener({ phase, ...extra });
  } catch {
    // A progress reader must never fail the build it is watching.
  }
}

/** The current listener, for a caller that hands work to another context. */
export function currentBindingProgressListener():
  BindingProgressListener | undefined {
  return storage.getStore();
}

/** Does the caller want the phase stream instead of the plain answer? */
export function wantsBindingProgress(
  accept: string | null | undefined,
  type: string = BINDING_PROGRESS_CONTENT_TYPE,
): boolean {
  if (!accept) return false;
  return accept
    .split(",")
    .some(part => part.split(";")[0].trim().toLowerCase() === type);
}

/**
 * Fan one build's events out to every request waiting on it: the builder
 * reports into `emit`, each waiter `subscribe`s and first gets the latest
 * event so a late joiner starts from where the build is, not from nothing.
 */
export class BindingProgressHub {
  private readonly listeners = new Set<BindingProgressListener>();
  private last: BindingProgressEvent | null = null;

  emit = (event: BindingProgressEvent): void => {
    this.last = event;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // See reportBindingPhase.
      }
    }
  };

  subscribe(listener: BindingProgressListener): () => void {
    this.listeners.add(listener);
    if (this.last) listener(this.last);
    return () => this.listeners.delete(listener);
  }
}

/** What a progress-streamed route finally answers. */
export interface BindingProgressOutcome {
  status: number;
  body: object;
  /**
   * A local file whose bytes follow the terminal line (which then says how
   * many with `bytes`), deleted once sent. Only for LIVE_BINDING_STREAM —
   * the sandbox needs the parquet itself, not a link to it.
   */
  tailFile?: string;
}

/**
 * The API → sandbox leg of a live binding: NDJSON phase lines, then, after
 * a `ready` line carrying `bytes`, exactly that many raw parquet bytes. Not
 * NDJSON any more after that line, hence its own type; only the dev server
 * Mako writes into the box asks for it.
 */
export const LIVE_BINDING_STREAM_CONTENT_TYPE =
  "application/vnd.mako.live-binding-stream";

export interface BindingProgressStreamOptions {
  /** Extra response headers, e.g. the preview host's wildcard ACAO. */
  headers?: Record<string, string>;
  /**
   * While a phase lasts this long without news, repeat it with
   * `elapsedMs`. A byte every few seconds also keeps Cloudflare's 100 s
   * idle limit from cutting a long rebuild into a 524.
   */
  heartbeatMs?: number;
  /** writing_parquet arrives per 5000-row batch; send at most this often. */
  throttleMs?: number;
  /** Default BINDING_PROGRESS_CONTENT_TYPE. */
  contentType?: string;
}

const encoder = new TextEncoder();

/**
 * Answer with the phase stream: start `run` NOW (inside the caller's async
 * context, so its query labels and guards still apply), write every phase it
 * reports, then its outcome as the terminal event. The HTTP status is 200
 * because the headers leave before the outcome is known; the terminal event
 * carries the status the plain route would have answered with.
 */
export function bindingProgressResponse(
  run: () => Promise<BindingProgressOutcome>,
  opts: BindingProgressStreamOptions = {},
): Response {
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const throttleMs = opts.throttleMs ?? 250;
  const startedAt = Date.now();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  let last: BindingProgressEvent | null = null;
  let lastSentAt = 0;
  let pending: BindingProgressEvent | null = null;

  const write = (payload: Record<string, unknown>) => {
    if (!open) return;
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      lastSentAt = Date.now();
    } catch {
      open = false;
    }
  };
  const send = (event: BindingProgressEvent) => {
    pending = null;
    write({ ...event, elapsedMs: Date.now() - startedAt });
  };
  const listener: BindingProgressListener = event => {
    const samePhase = last?.phase === event.phase;
    last = event;
    if (samePhase && Date.now() - lastSentAt < throttleMs) {
      pending = event;
      return;
    }
    send(event);
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // The client went away. The build carries on (exactly as it does when
      // a plain request is abandoned); there is just nobody to tell.
      open = false;
      clearInterval(beat);
    },
  });

  const beat = setInterval(
    () => {
      if (pending) return send(pending);
      if (last && Date.now() - lastSentAt >= heartbeatMs) send(last);
    },
    Math.min(heartbeatMs, throttleMs * 4),
  );
  beat.unref?.();

  const close = () => {
    if (!open) return;
    open = false;
    try {
      controller.close();
    } catch {
      // Already cancelled.
    }
  };
  const finish = (payload: Record<string, unknown>) => {
    clearInterval(beat);
    if (pending) send(pending);
    write({ ...payload, elapsedMs: Date.now() - startedAt });
  };
  const sendTail = async (filePath: string) => {
    try {
      for await (const chunk of createReadStream(filePath)) {
        if (!open) break;
        controller.enqueue(new Uint8Array(chunk as Buffer));
      }
    } finally {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  };

  void withBindingProgress(listener, run).then(
    async outcome => {
      const ok = outcome.status >= 200 && outcome.status < 300;
      if (ok && outcome.tailFile) {
        const size = (await stat(outcome.tailFile)).size;
        finish({ ...outcome.body, phase: "ready", bytes: size });
        await sendTail(outcome.tailFile).catch(error => {
          // The terminal line promised `bytes`; ending short tells the
          // reader the transfer broke rather than handing it a bad file.
          logger.warn("Apps live binding stream broke mid-file", { error });
          open = false;
          controller.error(error);
        });
        return close();
      }
      finish(
        ok
          ? { ...outcome.body, phase: "ready" }
          : { ...outcome.body, phase: "failed", status: outcome.status },
      );
      close();
    },
    error => {
      logger.error("Apps binding progress stream failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      finish({
        phase: "failed",
        status: 500,
        success: false,
        error: "Internal server error",
      });
      close();
    },
  );

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": opts.contentType ?? BINDING_PROGRESS_CONTENT_TYPE,
      // no-transform: neither Hono's compress() nor Cloudflare may buffer
      // the stream to gzip it, which would hold every event to the end.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Vary: "Accept",
      ...opts.headers,
    },
  });
}

/**
 * The signed URL `serveParquetArtifact` would redirect to, without building
 * the 302. `null`: the artifact does not exist. `undefined`: it exists but
 * this store streams (filesystem store, redirects off, signing failed) — the
 * client then GETs the data path without the stream header and is served
 * the bytes exactly as before.
 */
export async function signedParquetUrl(
  store: ArtifactStore,
  key: string,
  /** A URL fixed for this window (app-origin.ts), as serveParquetArtifact. */
  stable?: { windowMs: number },
): Promise<string | null | undefined> {
  if (!(await store.exists(key))) return null;
  if ((await artifactDeliveryMode(store)) !== "redirect") return undefined;
  try {
    return (await signArtifactUrl(store, key, stable)).url ?? undefined;
  } catch (error) {
    logger.warn("Apps binding link: signing failed; client will stream", {
      storeType: store.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * A stored artifact's GET as phase events: `resolving` while the route finds
 * which artifact the name means (the deployment's binding index, or a repo
 * read when it has none), `signing` while it signs, then `ready` with the
 * `url` and both durations.
 */
export async function parquetLinkOutcome(
  name: string,
  resolve: () => Promise<{ store: ArtifactStore; key: string } | null>,
  stable?: { windowMs: number },
): Promise<BindingProgressOutcome> {
  reportBindingPhase("resolving");
  const resolveStart = Date.now();
  const target = await resolve();
  const resolveMs = Date.now() - resolveStart;
  const missing: BindingProgressOutcome = {
    status: 404,
    body: { success: false, error: `Binding "${name}" not materialized` },
  };
  if (!target) return missing;
  reportBindingPhase("signing");
  const signStart = Date.now();
  const url = await signedParquetUrl(target.store, target.key, stable);
  const signMs = Date.now() - signStart;
  if (url === null) return missing;
  return {
    status: 200,
    body: {
      binding: name,
      ...(url ? { url } : {}),
      timings: { resolveMs, signMs },
    },
  };
}

/** `Server-Timing` for the plain 302/200 answer (visible in DevTools). */
export function serverTimingHeader(timings: Record<string, number>): string {
  return Object.entries(timings)
    .map(([name, ms]) => `${name};dur=${Math.round(ms)}`)
    .join(", ");
}
