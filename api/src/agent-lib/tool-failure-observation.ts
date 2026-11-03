import { updateActiveObservation } from "@langfuse/tracing";
import type { ToolSet } from "ai";
import {
  toolFailureFromOutput,
  toolFailureFromThrown,
  type ToolFailureSummary,
} from "./tool-failure";

function isAsyncIterable(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as object)
  );
}

function markToolSpanFailed(failure: ToolFailureSummary): void {
  updateActiveObservation(
    { level: "ERROR", statusMessage: failure.message },
    { asType: "tool" },
  );
}

/**
 * Mark the Langfuse tool observation ERROR when a tool fails.
 *
 * A resolved `{ success: false }` is successful JavaScript to the AI SDK, so
 * its span would otherwise read as a success. This has to happen inside
 * `execute`: that is the only callback the AI SDK (v7+) runs with the tool
 * span active — `onToolExecutionEnd` fires after the span's context exits.
 */
export function withToolFailureObservation<T extends ToolSet>(tools: T): T {
  const wrapped: Record<string, unknown> = { ...tools };
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: unknown }).execute;
    if (typeof execute !== "function") continue;
    wrapped[name] = {
      ...toolDef,
      execute: async (input: unknown, options: unknown) => {
        let result: unknown;
        try {
          result = await (
            execute as (input: unknown, options: unknown) => unknown
          )(input, options);
        } catch (error) {
          markToolSpanFailed(toolFailureFromThrown(error));
          throw error;
        }
        if (isAsyncIterable(result)) return result;
        const failure = toolFailureFromOutput(result);
        if (failure) markToolSpanFailed(failure);
        return result;
      },
    };
  }
  return wrapped as T;
}
