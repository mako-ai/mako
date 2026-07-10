/**
 * Browser-side kernel execution client. Talks to the notebook session +
 * execution routes on the control plane; the control plane drives the actual
 * Python kernel on GKE (the browser never touches a pod).
 *
 * Execution streams outputs over SSE. EventSource can't POST, so we POST with
 * fetch and parse the SSE frames off the response body ourselves.
 */
import { api } from "../api/client";

/** A rendered output from executing a code cell (mirrors the server union). */
export type KernelOutput =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | { type: "result"; data: Record<string, unknown> }
  | { type: "display"; data: Record<string, unknown> }
  | { type: "error"; ename: string; evalue: string; traceback: string[] };

export interface ExecuteResult {
  status: "ok" | "error" | "abort";
  executionCount: number | null;
}

/** Start (idempotently) the notebook's kernel session. Throws on failure. */
export async function startKernelSession(
  workspaceId: string,
  notebookId: string,
): Promise<void> {
  const { error } = await api.POST(
    "/api/workspaces/{workspaceId}/notebooks/{id}/sessions",
    { params: { path: { workspaceId, id: notebookId } } },
  );
  if (error) {
    const message =
      (error as { error?: string })?.error ?? "Failed to start kernel";
    throw new Error(message);
  }
}

/** Stop the notebook's kernel session. Best-effort. */
export async function stopKernelSession(
  workspaceId: string,
  notebookId: string,
): Promise<void> {
  await api.DELETE(
    "/api/workspaces/{workspaceId}/notebooks/{id}/sessions/current",
    { params: { path: { workspaceId, id: notebookId } } },
  );
}

interface SseEvent {
  event: string;
  data: string;
}

/** Split accumulated SSE text into complete `event:/data:` frames. */
function parseSseFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? ""; // trailing partial frame
  for (const chunk of chunks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

/**
 * Execute `code` on the notebook's kernel, invoking `onOutput` for each
 * rendered output as it streams. Resolves with the terminal execution result,
 * or rejects if the kernel reports failure / the request aborts.
 */
export async function executeCode(
  workspaceId: string,
  notebookId: string,
  code: string,
  onOutput: (output: KernelOutput) => void,
  signal?: AbortSignal,
): Promise<ExecuteResult> {
  const res = await fetch(
    `/api/workspaces/${workspaceId}/notebooks/${notebookId}/executions`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": workspaceId,
      },
      body: JSON.stringify({ code }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`Execution request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ExecuteResult | null = null;
  let failure: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.rest;
    for (const evt of parsed.events) {
      switch (evt.event) {
        case "stream":
        case "result":
        case "display":
        case "error":
          onOutput(JSON.parse(evt.data) as KernelOutput);
          break;
        case "done":
          result = JSON.parse(evt.data) as ExecuteResult;
          break;
        case "failed":
          failure = (JSON.parse(evt.data) as { message: string }).message;
          break;
      }
    }
  }

  if (failure) throw new Error(failure);
  return result ?? { status: "ok", executionCount: null };
}
