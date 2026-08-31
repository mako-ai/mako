import { useEffect, useRef, type MutableRefObject } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useConsoleStore } from "../../../store/consoleStore";
import { useRealtimeStore } from "../../../store/realtimeStore";
import { useDbtStore } from "../../../store/dbtStore";
import { DBT_SERVER_MUTATION_TOOLS } from "../tool-presentation";

type ChatHelpers = UseChatHelpers<UIMessage>;

export interface UseServerToolSyncArgs {
  chatId: string;
  workspaceId: string | undefined;
  messages: ChatHelpers["messages"];
}

/**
 * In-band reconciliation of SERVER-executed tool results against this
 * window's open tabs, riding the resumable chat stream (issue #475 pattern).
 *
 * Console sync: when a server-side console tool result streams in (state
 * "output-available"), reconcile THIS window against the server draft. The
 * chat stream is resumable, so unlike the workspace realtime poke channel
 * this survives SSE drops, half-closes, frozen background tabs, reconnects
 * and page refreshes — the replayed part triggers the same idempotent
 * reconciliation.
 *
 *   - create_console / open_console -> open the tab here.
 *   - modify_console / set_console_connection -> pull the authoritative
 *     draft for open tabs (revision sync). Without this, an agent EDIT
 *     reached the editor ONLY via the realtime poke; a missed poke (dead
 *     SSE, or a poke that raced the tab open) left the editor stale until
 *     the next focus/reconnect/watchdog/refresh — the reported "modify did
 *     nothing until I refreshed" bug. create_console never had this problem
 *     because it already rode the chat stream (asymmetry, issue #475).
 *
 * App/dbt sync: the app_* and dbt file mutation tools execute SERVER-SIDE,
 * so an OPEN app / dbt tab learns about the agent's write via the workspace
 * realtime poke (app.updated / dbt.file.updated). That poke rides the
 * workspace SSE, which a mobile lock / laptop sleep / proxy half-close can
 * kill — so reconcile off the RESUMABLE CHAT STREAM too: when the tool
 * result streams in (or is replayed after a wake reattach), refetch the
 * open app / dbt file (poke = fast path, this = robust backstop).
 *
 * Returns `handledConsoleOpenToolCallIdsRef` so the session loader can seed
 * it: tool call ids seen in RESTORED history must not re-trigger the console
 * opener (the dedicated consoles-restore payload handles reopening).
 */
export function useServerToolSync({
  chatId,
  workspaceId,
  messages,
}: UseServerToolSyncArgs): {
  handledConsoleOpenToolCallIdsRef: MutableRefObject<Set<string>>;
} {
  const handledConsoleOpenToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledConsoleOpenToolCallIdsRef.current = new Set();
  }, [chatId]);
  useEffect(() => {
    if (!workspaceId) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts ?? []) {
      const p = part as {
        type?: string;
        toolName?: string;
        state?: string;
        toolCallId?: string;
        output?: { success?: boolean; consoleId?: string };
      };
      const toolName =
        p.type === "dynamic-tool"
          ? p.toolName
          : p.type?.startsWith("tool-")
            ? p.type.slice("tool-".length)
            : undefined;
      const opensTab =
        toolName === "create_console" || toolName === "open_console";
      // Server console writes whose only client delivery is the realtime poke.
      // run_console bumps the draft revision AND persists a run artifact
      // (tab.lastRun); the revision sync refreshes both, and Editor.tsx
      // reactively renders lastRun into the results panel — so reconciling
      // here surfaces agent run RESULTS even when the run.completed poke was
      // missed (dead/half-closed SSE), matching modify/set-connection.
      const editsConsole =
        toolName === "modify_console" ||
        toolName === "set_console_connection" ||
        toolName === "run_console";
      if (!opensTab && !editsConsole) continue;
      if (p.state !== "output-available") continue;
      if (!p.toolCallId || !p.output?.success) continue;
      // Opening needs a consoleId; an edit reconciles all open tabs so it
      // does not. Don't burn the dedupe slot on an opener that lacks an id.
      if (opensTab && !p.output?.consoleId) continue;
      if (handledConsoleOpenToolCallIdsRef.current.has(p.toolCallId)) continue;
      handledConsoleOpenToolCallIdsRef.current.add(p.toolCallId);
      if (opensTab) {
        const consoleId = p.output.consoleId as string;
        void (async () => {
          await useConsoleStore
            .getState()
            .openConsoleFromServer(workspaceId, consoleId);
          // A create followed immediately by a modify can drop the modify's
          // workspace poke while the tab is still opening; reconcile once the
          // tab carries a revision base so it never sticks on create-time
          // content.
          void useRealtimeStore.getState().syncRevisions();
        })();
      } else {
        void useRealtimeStore.getState().syncRevisions();
      }
    }
  }, [messages, workspaceId]);

  const handledEntitySyncToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledEntitySyncToolCallIdsRef.current = new Set();
  }, [chatId]);
  useEffect(() => {
    if (!workspaceId) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts ?? []) {
      const p = part as {
        type?: string;
        toolName?: string;
        state?: string;
        toolCallId?: string;
        input?: { appId?: string; projectId?: string; path?: string };
        output?: { success?: boolean };
      };
      const toolName =
        p.type === "dynamic-tool"
          ? p.toolName
          : p.type?.startsWith("tool-")
            ? p.type.slice("tool-".length)
            : undefined;
      if (!toolName) continue;
      if (!DBT_SERVER_MUTATION_TOOLS.has(toolName)) continue;
      if (
        p.state !== "output-available" ||
        !p.toolCallId ||
        !p.output?.success
      ) {
        continue;
      }
      if (handledEntitySyncToolCallIdsRef.current.has(p.toolCallId)) continue;
      handledEntitySyncToolCallIdsRef.current.add(p.toolCallId);

      const projectId = p.input?.projectId;
      const path = p.input?.path;
      if (!projectId || !path) continue;
      const dbt = useDbtStore.getState();
      // Only touch projects this window has loaded.
      if (dbt.filePathsByProject[projectId]) {
        void dbt.applyRemoteFileUpdate(
          workspaceId,
          projectId,
          path,
          toolName === "delete_dbt_file",
        );
      }
    }
  }, [messages, workspaceId]);

  return { handledConsoleOpenToolCallIdsRef };
}
