/**
 * Tag every BigQuery job an agent tool starts with `mako_source=agent` plus
 * the tool, chat and user (see services/bigquery-labels.ts).
 *
 * The context is entered inside `execute`, the one callback that runs the
 * tool's own code, so it reaches the query builders however deep the tool
 * goes. A tool that runs something with its own source (a console, an app
 * binding) sets that source inside and wins; the chat and user still apply.
 */
import type { ToolSet } from "ai";
import { withQueryLabels, type QueryLabels } from "../services/bigquery-labels";

export function withToolQueryLabels<T extends ToolSet>(
  tools: T,
  labels: QueryLabels,
): T {
  const wrapped: Record<string, unknown> = { ...tools };
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: unknown }).execute;
    if (typeof execute !== "function") continue;
    wrapped[name] = {
      ...toolDef,
      execute: (input: unknown, options: unknown) =>
        withQueryLabels(
          { mako_source: "agent", ...labels, mako_tool: name },
          () =>
            (execute as (input: unknown, options: unknown) => unknown)(
              input,
              options,
            ),
        ),
    };
  }
  return wrapped as T;
}
