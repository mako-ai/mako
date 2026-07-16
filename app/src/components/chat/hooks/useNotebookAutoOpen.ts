import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";

import { useNotebookStore } from "../../../store/notebookStore";
import { focusNotebookTab } from "../../../notebook-runtime/shell";
import { toolNameFromPartType } from "../tool-presentation";

/**
 * Surface a notebook the agent just created — off the **chat stream**, not the
 * workspace realtime channel.
 *
 * `create_notebook` runs server-side (headless), so the browser only learns of
 * the new notebook through a poke. The workspace realtime channel (Redis
 * pub/sub) is ephemeral: on prod's multi-instance Cloud Run it's easily missed
 * (the client's realtime SSE can reconnect mid-run, and there's no replay), so
 * the new notebook wouldn't appear or open until a page reload. The chat stream,
 * by contrast, is the SSE the user is actively watching, and it carries the
 * tool's *result* (`{ notebookId, name }`) — a reliable signal.
 *
 * When a `create_notebook` tool part settles with a notebook id, refresh the
 * explorer list and open the notebook — once per tool call.
 */
export function useNotebookAutoOpen(messages: UIMessage[]): void {
  const handled = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts ?? []) {
        const partType = part.type as string;
        if (toolNameFromPartType(partType) !== "create_notebook") continue;

        const record = part as Record<string, unknown>;
        if (record.state !== "output-available") continue;

        const toolCallId = record.toolCallId as string | undefined;
        if (!toolCallId || handled.current.has(toolCallId)) continue;

        const output = record.output as
          | { success?: boolean; notebookId?: string; name?: string }
          | undefined;
        if (!output?.notebookId) continue;

        handled.current.add(toolCallId);
        void useNotebookStore.getState().loadNotebooks();
        focusNotebookTab(output.notebookId, output.name || "Untitled notebook");
      }
    }
  }, [messages]);
}
