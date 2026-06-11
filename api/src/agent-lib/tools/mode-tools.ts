/**
 * Core mode-lifecycle server tools: `enable_mode` and `todo_write`.
 *
 * `enable_mode` mutates the per-request `ModeState` so that `prepareStep` can
 * recompute `activeTools` + the dynamic system block on the next step. The
 * actual tool/prompt swap happens in `prepareStep`; this tool only records the
 * intent and tells the model which tools it just gained.
 *
 * `todo_write` is a Claude-Code-style task tracker. It simply echoes the todos
 * back (the UI renders them); the active modes' trajectories are surfaced in
 * its description so the model has concrete hints for the current surface.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  modeRegistry,
  EXPERTISE_MODE_IDS,
  toolNamesForModes,
} from "../../agents/modes/registry";
import type { ExpertiseModeId, ModeState } from "../../agents/modes/types";

const enableModeSchema = z.object({
  mode: z
    .enum(["sql", "dashboard", "flow", "explore"])
    .describe(
      "Which expertise mode to enable. Loads that mode's tools and guidance.",
    ),
});

const todoItemSchema = z.object({
  id: z.string().optional().describe("Stable identifier for this todo."),
  content: z.string().describe("Short, actionable description of the step."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Lifecycle status of the step."),
});

const todoWriteSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .describe(
      "The full, current todo list. Re-send the entire list on every update.",
    ),
});

function buildTodoDescription(modeState: ModeState): string {
  const trajectories = Array.from(modeState.enabledModes)
    .flatMap(modeId => modeRegistry[modeId]?.trajectories ?? [])
    .filter(Boolean);

  const base =
    "Create and update a structured todo list to track progress on multi-step work. " +
    "Re-send the entire list each time; mark items in_progress/completed as you go.";

  if (trajectories.length === 0) return base;

  return `${base}\n\nTypical steps for the current surface:\n${trajectories
    .map(t => `- ${t}`)
    .join("\n")}`;
}

/**
 * Create the core mode tools bound to a per-request mutable `ModeState`.
 */
export function createModeTools(modeState: ModeState) {
  return {
    enable_mode: tool({
      description:
        "Load an expertise mode's tools and guidance. Modes: " +
        EXPERTISE_MODE_IDS.map(
          id => `'${id}' (${modeRegistry[id].routingPrompt})`,
        ).join(", ") +
        ". Call this before using a mode's tools; the response lists the tools you gained.",
      inputSchema: enableModeSchema,
      execute: async ({ mode }: { mode: ExpertiseModeId }) => {
        const definition = modeRegistry[mode];
        if (!definition) {
          return {
            success: false,
            error: `Unknown mode '${mode}'. Valid modes: ${EXPERTISE_MODE_IDS.join(", ")}.`,
          };
        }

        modeState.enabledModes.add(mode);

        const availableToolNames = Array.from(
          toolNamesForModes(modeState.enabledModes),
        ).sort();

        return {
          success: true,
          enabledMode: mode,
          modeName: definition.name,
          readOnly: Boolean(definition.readOnly),
          enabledModes: Array.from(modeState.enabledModes),
          newlyAvailableTools: definition.toolNames,
          availableTools: availableToolNames,
          note:
            modeState.planSubmitted && !modeState.planApproved
              ? "A plan is awaiting approval: only read-only tools from these modes are usable until the user approves it."
              : undefined,
        };
      },
    }),

    todo_write: tool({
      description: buildTodoDescription(modeState),
      inputSchema: todoWriteSchema,
      execute: async ({
        todos,
      }: {
        todos: Array<z.infer<typeof todoItemSchema>>;
      }) => {
        return {
          success: true,
          todos,
          counts: {
            total: todos.length,
            pending: todos.filter(t => t.status === "pending").length,
            in_progress: todos.filter(t => t.status === "in_progress").length,
            completed: todos.filter(t => t.status === "completed").length,
            cancelled: todos.filter(t => t.status === "cancelled").length,
          },
        };
      },
    }),
  };
}
