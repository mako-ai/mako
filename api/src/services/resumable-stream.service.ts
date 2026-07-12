/**
 * Resumable chat streams
 *
 * Buffers the SSE stream of each chat turn so clients can detach and
 * reattach — page refresh, tab close + return, second device, multiple
 * viewers — without killing or losing the generation. Built on the
 * `resumable-stream` package (the same one used by the official AI SDK
 * resume-streams recipe), on top of the shared pluggable pub/sub backend
 * (see pubsub.service.ts):
 *
 *   - REDIS_URL set: Redis pub/sub. Required when running more than one API
 *     instance, because a resume GET may land on a different instance than
 *     the one producing the stream.
 *   - REDIS_URL unset: in-process pub/sub with identical semantics. Zero
 *     extra infrastructure for local dev and single-instance self-hosting.
 *     Streams don't survive a process restart in this mode; clients then
 *     fall back to the chat saved in MongoDB.
 */
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream/generic";
import {
  createPubSubPublisher,
  createPubSubSubscriber,
  getPubSubBackendKind,
} from "./pubsub.service";
import { loggers } from "../logging";

const logger = loggers.agent();

let streamContext: ResumableStreamContext | null = null;

export function getResumableStreamContext(): ResumableStreamContext {
  if (streamContext) return streamContext;

  // On a long-lived Node server there is no serverless waitUntil; background
  // stream consumption just runs on the event loop. Surface failures in logs.
  const waitUntil = (promise: Promise<unknown>): void => {
    void promise.catch(error =>
      logger.warn("Resumable stream background task failed", { error }),
    );
  };

  // Separate publisher/subscriber handles: a Redis connection in subscriber
  // mode cannot issue regular commands (in memory mode both share the same
  // process-wide backend).
  streamContext = createResumableStreamContext({
    keyPrefix: "mako:resumable-stream",
    waitUntil,
    publisher: createPubSubPublisher(),
    subscriber: createPubSubSubscriber(),
  });

  const backend = getPubSubBackendKind();
  if (backend === "redis") {
    logger.info("Resumable streams backed by Redis", { backend });
  } else {
    logger.info(
      "Resumable streams backed by in-process pub/sub (single instance only — set REDIS_URL when scaling out)",
      { backend },
    );
  }

  return streamContext;
}

/**
 * Per-process registry of in-flight generations, keyed by chatId. Powers the
 * explicit stop endpoint: with resumable streams a client disconnect no
 * longer aborts the turn, so Stop must reach the producing process.
 *
 * Note: when running multiple instances behind Redis, a stop request that
 * lands on a non-producing instance still clears the resume pointer in
 * MongoDB but cannot abort the LLM call on the other instance.
 */
interface ActiveGeneration {
  streamId: string;
  abortController: AbortController;
}

const activeGenerations = new Map<string, ActiveGeneration>();

export function registerActiveGeneration(
  chatId: string,
  streamId: string,
  abortController: AbortController,
): void {
  const existing = activeGenerations.get(chatId);
  if (existing && existing.abortController !== abortController) {
    existing.abortController.abort();
  }
  activeGenerations.set(chatId, { streamId, abortController });
}

/** Abort the in-flight generation for a chat. Returns true if one was found. */
export function stopActiveGeneration(chatId: string): boolean {
  const active = activeGenerations.get(chatId);
  if (!active) return false;
  activeGenerations.delete(chatId);
  active.abortController.abort();
  return true;
}

/** Remove the registry entry, but only if it still belongs to this turn. */
export function clearActiveGeneration(chatId: string, streamId: string): void {
  if (activeGenerations.get(chatId)?.streamId === streamId) {
    activeGenerations.delete(chatId);
  }
}
