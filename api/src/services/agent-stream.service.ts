/**
 * Agent chat stream lifecycle: SSE keep-alive wrapping, screenshot-vision
 * message assembly, and the resume/stop endpoints' logic. Extracted from
 * agent.routes.ts so the route file stays a thin spec + handler layer.
 */
import { ObjectId } from "mongodb";
import {
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  UI_MESSAGE_STREAM_HEADERS,
} from "ai";
import { saveTurnCheckpoint } from "./agent-thread.service";
import { Chat } from "../database/workspace-schema";
import { workspaceService } from "./workspace.service";
import {
  getResumableStreamContext,
  stopActiveGeneration,
} from "./resumable-stream.service";
import { publishRealtimeEvent } from "./realtime.service";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";
import { loggers } from "../logging";

const logger = loggers.agent();

// ── Screenshot vision attachments ────────────────────────────────

export interface ScreenshotVisionAttachment {
  renderer?: string;
  filename?: string;
  mediaType?: string;
  dataUrl?: string;
  outputBytes?: number;
  targetLabel?: string;
}

const MAX_SCREENSHOT_VISION_ATTACHMENTS = 6;
const MAX_SCREENSHOT_VISION_BYTES = 2_000_000;

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return dataUrl.length;
  return Math.floor(((dataUrl.length - commaIndex - 1) * 3) / 4);
}

/**
 * Assemble the trailing user message that carries `capture_screenshot`'s
 * images into the next model request.
 *
 * `supportsVision: false` must NOT silently drop the images. The model just
 * called a screenshot tool and is about to answer a question about what is on
 * screen; leaving it with no message at all invites a confident description of
 * an image nobody showed it. It gets a text note instead, and the run keeps
 * going.
 *
 * Sending the images anyway is a hard failure, not a degradation: text-only
 * models reject the request outright ("messages.content.type is invalid,
 * allowed values: ['text']" / "Model only supports text input; received
 * unsupported content type 'image_url'"), which kills the turn. That was the
 * single largest source of chat errors in the 21 days before this gate landed.
 */
export function buildScreenshotVisionModelMessage(
  attachments: ScreenshotVisionAttachment[] | undefined,
  options: { supportsVision?: boolean } = {},
) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  const accepted = attachments
    .filter(attachment => {
      if (
        typeof attachment.dataUrl !== "string" ||
        !attachment.dataUrl.startsWith("data:image/")
      ) {
        return false;
      }
      const byteCount =
        typeof attachment.outputBytes === "number"
          ? attachment.outputBytes
          : estimateDataUrlBytes(attachment.dataUrl);
      return byteCount <= MAX_SCREENSHOT_VISION_BYTES;
    })
    .slice(0, MAX_SCREENSHOT_VISION_ATTACHMENTS);

  if (accepted.length === 0) {
    return null;
  }

  // undefined = assume vision (external MCP clients, unknown models).
  if (options.supportsVision === false) {
    return {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text:
            `The screenshot tool captured ${accepted.length} image(s), but the ` +
            "selected model cannot read images, so they were not attached. " +
            "Do NOT describe what they show. Say plainly that you cannot see " +
            "the screenshot, and either work from non-visual evidence (page " +
            "text, console output, the DOM summary in the tool result) or ask " +
            "the user to switch to a vision-capable model.",
        },
      ],
    };
  }

  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; filename?: string; data: string }
  > = [
    {
      type: "text",
      text:
        "The previous screenshot tool call captured these PNG images for visual inspection. " +
        "Look at the actual images, describe what is visible, and use them as visual evidence when answering.",
    },
  ];

  accepted.forEach((attachment, index) => {
    const renderer = attachment.renderer || `renderer-${index + 1}`;
    const filename = attachment.filename || `${renderer}.png`;
    content.push({
      type: "text",
      text: `Screenshot ${index + 1}: ${renderer} (${filename})`,
    });
    content.push({
      type: "file",
      mediaType: attachment.mediaType || "image/png",
      filename,
      data: attachment.dataUrl as string,
    });
  });

  return {
    role: "user" as const,
    content,
  };
}

// ── SSE keep-alive ────────────────────────────────────────────────

// Keep the SSE connection warm during long silent gaps.
//
// While a server-side tool runs (e.g. a multi-minute `dbt build`) the AI SDK
// emits the `tool-input-available` chunk and then sends nothing on the wire
// until the tool resolves. Edge proxies (Cloudflare's origin idle timeout is
// ~100s with no bytes) terminate a connection that goes quiet for too long —
// which drops the live stream and strands the in-flight tool card on
// "Running…" in the browser. Emitting an SSE comment line on a fixed interval
// keeps bytes flowing without affecting the protocol: lines beginning with
// `:` are comments per the SSE spec and are ignored by the AI SDK's stream
// parser. We wrap only the live client-facing branch; the tee'd
// resumable-stream copy is untouched, so keepalives are never buffered or
// replayed on reconnect.
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export function withSseKeepAlive(
  response: Response,
  intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
): Response {
  if (!response.body) return response;

  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stopKeepAlive = () => {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // Controller already closed/errored — stop pinging.
          stopKeepAlive();
        }
      }, intervalMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stopKeepAlive();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        stopKeepAlive();
        controller.error(error);
      }
    },
    cancel(reason) {
      stopKeepAlive();
      void reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ── Stream access authorization ───────────────────────────────────

/**
 * Shared guard for the resume/stop endpoints: the caller must be an
 * authenticated user with access to the chat's workspace, or an API key
 * scoped to that workspace.
 */
export async function authorizeChatStreamAccess(
  c: AuthenticatedContext,
  chatId: string,
): Promise<
  | {
      ok: true;
      chat: { activeStreamId?: string | null; workspaceId: string };
    }
  | { ok: false; status: 400 | 401 | 403 | 404 }
> {
  const user = c.get("user");
  const apiKeyWorkspace = c.get("workspace");

  if (!ObjectId.isValid(chatId)) {
    return { ok: false, status: 400 };
  }

  const chat = await Chat.findById(chatId).select("workspaceId activeStreamId");
  if (!chat) {
    return { ok: false, status: 404 };
  }

  const chatWorkspaceId = chat.workspaceId.toString();
  if (apiKeyWorkspace) {
    if (apiKeyWorkspace._id.toString() !== chatWorkspaceId) {
      return { ok: false, status: 403 };
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(
      chatWorkspaceId,
      user.id,
    );
    if (!hasAccess) {
      return { ok: false, status: 403 };
    }
  } else {
    return { ok: false, status: 401 };
  }

  return {
    ok: true,
    chat: { activeStreamId: chat.activeStreamId, workspaceId: chatWorkspaceId },
  };
}

// ── Resume / stop lifecycle ───────────────────────────────────────

export type ResumeChatStreamResult =
  /** Nothing to resume — respond 204. `reason` discriminates the outcomes. */
  | {
      kind: "no-content";
      reason: "chat-not-found" | "no-active-stream" | "stale-pointer";
    }
  | { kind: "forbidden"; status: 400 | 401 | 403 }
  /** Reattached — pipe this SSE response to the client. */
  | { kind: "stream"; response: Response };

/**
 * Reattach the caller to the chat's in-flight turn: buffered chunks are
 * replayed, then live chunks follow. Multiple clients may attach to the same
 * stream concurrently.
 */
export async function resumeChatStream(
  c: AuthenticatedContext,
  chatId: string,
): Promise<ResumeChatStreamResult> {
  const access = await authorizeChatStreamAccess(c, chatId);
  if (!access.ok) {
    // A not-yet-created chat (client-minted chatId, no turn sent) is a normal
    // "nothing to resume" case, not an error.
    if (access.status === 404) {
      logger.debug("Stream resume: nothing to resume", {
        chatId,
        reason: "chat-not-found",
      });
      return { kind: "no-content", reason: "chat-not-found" };
    }
    return { kind: "forbidden", status: access.status };
  }

  const { activeStreamId } = access.chat;
  if (!activeStreamId) {
    logger.debug("Stream resume: nothing to resume", {
      chatId,
      reason: "no-active-stream",
    });
    return { kind: "no-content", reason: "no-active-stream" };
  }

  const stream =
    await getResumableStreamContext().resumeExistingStream(activeStreamId);
  if (!stream) {
    // Stale pointer: stream expired or was lost (e.g. process restart with
    // the in-memory backend, or a `/stop` handled by another instance). The
    // client minted a turn but we can no longer reattach — this is the
    // server-side counterpart of the client's silent-disconnect rescue.
    logger.info("Stream resume: stale pointer, cannot reattach", {
      chatId,
      streamId: activeStreamId,
      reason: "stale-pointer",
    });
    // Clear it so future mounts short-circuit.
    void Chat.updateOne(
      { _id: new ObjectId(chatId), activeStreamId },
      { $set: { activeStreamId: null } },
    ).catch(error =>
      logger.warn("Failed to clear stale activeStreamId", { error, chatId }),
    );
    return { kind: "no-content", reason: "stale-pointer" };
  }

  logger.info("Client reattached to chat stream", {
    chatId,
    streamId: activeStreamId,
  });
  // Keep the reattached connection warm during long silent tool gaps, same
  // as the live POST branch. Without this, a client that resumes mid-turn is
  // dropped by the edge proxy's idle timeout (~100s with no bytes) whenever a
  // server-side tool runs quietly, stranding the resumed turn.
  return {
    kind: "stream",
    response: withSseKeepAlive(
      new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: UI_MESSAGE_STREAM_HEADERS,
      }),
    ),
  };
}

export type StopChatGenerationResult =
  | { kind: "stopped"; stopped: boolean }
  | { kind: "not-found" }
  | { kind: "forbidden"; status: 400 | 401 | 403 };

/**
 * Explicitly abort the chat's in-flight generation. With resumable streams a
 * client disconnect (refresh, tab close) intentionally no longer cancels the
 * turn, so the Stop button calls this. Aborting triggers the normal
 * onFinish(isAborted) path, which persists the partial assistant message and
 * clears the resume pointer.
 */
export async function stopChatGeneration(
  c: AuthenticatedContext,
  chatId: string,
): Promise<StopChatGenerationResult> {
  const access = await authorizeChatStreamAccess(c, chatId);
  if (!access.ok) {
    if (access.status === 404) return { kind: "not-found" };
    return { kind: "forbidden", status: access.status };
  }

  const stopped = stopActiveGeneration(chatId);

  // Clear the pointer immediately so reconnecting clients don't reattach to
  // the aborted stream. Finalization also clears it, but only on the
  // instance that owns the generation.
  await Chat.updateOne(
    { _id: new ObjectId(chatId) },
    { $set: { activeStreamId: null } },
  );
  publishRealtimeEvent(access.chat.workspaceId, {
    type: "chat.activity",
    chatId,
    state: "idle",
  });

  logger.info("Chat generation stop requested", { chatId, stopped });
  return { kind: "stopped", stopped };
}

// ---------------------------------------------------------------------------
// Turn checkpointing (§13.27)
// ---------------------------------------------------------------------------

/**
 * Decode the SSE-encoded UIMessage stream ("data: {json}\n\n" events) back
 * into UIMessageChunk objects. Pure; exported for tests. Unparseable events
 * are skipped — checkpointing is best-effort and must never break the tee'd
 * transport.
 */
export function createSseChunkDecoder(): TransformStream<
  string | Uint8Array,
  unknown
> {
  let buffer = "";
  const decoder = new TextDecoder();
  return new TransformStream({
    transform(chunk, controller) {
      buffer +=
        typeof chunk === "string"
          ? chunk
          : decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            controller.enqueue(JSON.parse(payload));
          } catch {
            // Skip malformed frames.
          }
        }
      }
    },
  });
}

const CHECKPOINT_INTERVAL_MS = 2_000;

/**
 * Consume a tee'd copy of the turn's SSE stream, reduce it to UIMessage
 * snapshots via the AI SDK, and checkpoint the in-progress assistant message
 * every couple of seconds. The final full save supersedes (and $unsets) the
 * checkpoint; the activeStreamId filter in saveTurnCheckpoint kills any late
 * trailing write.
 */
export async function trackTurnCheckpoints(input: {
  chatId: string;
  streamId: string;
  sseStream: ReadableStream<string | Uint8Array>;
}): Promise<void> {
  const { chatId, streamId, sseStream } = input;
  const chunks = sseStream.pipeThrough(
    createSseChunkDecoder(),
  ) as ReadableStream<UIMessageChunk>;
  let lastWrite = 0;
  let pending: UIMessage | null = null;
  try {
    for await (const snapshot of readUIMessageStream({ stream: chunks })) {
      pending = snapshot;
      const now = Date.now();
      if (now - lastWrite >= CHECKPOINT_INTERVAL_MS) {
        lastWrite = now;
        await saveTurnCheckpoint(chatId, streamId, snapshot);
        pending = null;
      }
    }
    // One final checkpoint so a crash between the last interval and the
    // finish loses nothing; finalization's $unset supersedes it shortly.
    if (pending) await saveTurnCheckpoint(chatId, streamId, pending);
  } catch (error) {
    logger.warn("Turn checkpoint tracking ended with an error", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
