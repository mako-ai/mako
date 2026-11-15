/**
 * A chat turn's abort scope.
 *
 * The turn's lifetime is decoupled from the HTTP connection: the SSE response
 * is buffered as a resumable stream, so a browser disconnect (refresh, tab
 * close, network drop) must NOT abort generation — reconnecting clients pick
 * the stream back up. Aborting is an explicit action via
 * POST /chat/:chatId/stop, which fires `controller` (registered with the
 * resumable-stream service once the stream starts).
 */
import type { AgentContext } from "../../agents";
import { createAgentExecutionId } from "../../agent-lib/tools/shared/truncation";
import { databaseConnectionService } from "../database-connection.service";

export interface TurnAbortScope {
  controller: AbortController;
  signal: AbortSignal;
  /** Database executions started by this turn's tools and not yet released. */
  executionIds: Set<string>;
  /** Cancel every currently-registered execution. */
  cancelRegisteredExecutions: () => Promise<void>;
  toolExecutionContext: NonNullable<AgentContext["toolExecutionContext"]>;
}

export function createTurnAbortScope(): TurnAbortScope {
  const controller = new AbortController();
  const signal = controller.signal;
  const executionIds = new Set<string>();

  // Invariant: this only runs as a batch on abort. Any execution registered
  // *after* the abort fires is individually cancelled inside
  // registerExecution (which checks signal.aborted synchronously after
  // adding the ID).
  const cancelRegisteredExecutions = async (): Promise<void> => {
    const ids = Array.from(executionIds);
    await Promise.allSettled(
      ids.map(executionId =>
        databaseConnectionService.cancelQuery(executionId),
      ),
    );
  };
  signal.addEventListener(
    "abort",
    () => {
      void cancelRegisteredExecutions();
    },
    { once: true },
  );

  const toolExecutionContext: TurnAbortScope["toolExecutionContext"] = {
    signal,
    createExecutionId: createAgentExecutionId,
    registerExecution: executionId => {
      executionIds.add(executionId);
      if (signal.aborted) {
        executionIds.delete(executionId);
        void databaseConnectionService.cancelQuery(executionId);
      }
    },
    releaseExecution: executionId => {
      executionIds.delete(executionId);
    },
    isAborted: () => signal.aborted,
  };

  return {
    controller,
    signal,
    executionIds,
    cancelRegisteredExecutions,
    toolExecutionContext,
  };
}
