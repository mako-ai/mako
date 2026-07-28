/**
 * Client-Side Plan-Lifecycle Tools
 *
 * These tools have NO `execute` function, so the AI SDK forwards the call to
 * the browser and pauses the agent loop until the client resolves them via
 * `addToolOutput`. They power the plan-mode state machine:
 *
 *   ask_clarifying_questions -> interactive form in the chat
 *   submit_plan              -> editable plan card (Approve / Request changes / Cancel)
 *
 * Both are deferred (human-in-the-loop). The client result flows back through
 * the normal `addToolOutput` path and is then visible to `deriveModeState` on
 * the next request (e.g. `submit_plan` decision === "approve" unlocks writes).
 */

import { tool } from "ai";
import { z } from "zod";

export const clarifyingQuestionSchema = z.object({
  id: z.string().describe("Stable identifier for this question."),
  prompt: z.string().describe("The question to ask the user."),
  type: z
    .enum(["choice", "text"])
    .describe(
      "'choice' renders selectable options; 'text' renders a free-text field.",
    ),
  options: z
    .array(z.string())
    .optional()
    .describe(
      "Selectable options (required when type is 'choice'). Do NOT include an " +
        "'Other' / 'Something else' entry — the form appends a free-text " +
        "'Other' choice automatically unless allowOther is false.",
    ),
  allowMultiple: z
    .boolean()
    .optional()
    .describe(
      "For 'choice' questions, allow selecting more than one option.",
    ),
  allowOther: z
    .boolean()
    .optional()
    .describe(
      "For 'choice' questions, append an 'Other' free-text option (defaults to true). " +
        "Set false when the listed options are exhaustive.",
    ),
  recommendedOption: z
    .string()
    .optional()
    .describe(
      "For single-choice questions, the exact label of the option you recommend as the " +
        "best default. The form badges it with 'Recommended'. Must match one entry in " +
        "'options' verbatim. Omit when you have no clear recommendation or when 'allowMultiple' is set.",
    ),
});

export const askClarifyingQuestionsSchema = z.object({
  questions: z
    .array(clarifyingQuestionSchema)
    .min(1)
    .describe(
      "Targeted questions whose answers you need before you can plan or act.",
    ),
});

export const planTodoSchema = z.object({
  id: z.string().optional().describe("Stable identifier for this todo."),
  content: z.string().describe("Short, actionable description of the step."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional()
    .describe("Lifecycle status of the step (defaults to 'pending')."),
});

export const submitPlanSchema = z.object({
  title: z.string().describe("Concise title summarizing the plan."),
  planMarkdown: z
    .string()
    .describe(
      "The full plan as Markdown: goal, approach, and the changes you intend to make.",
    ),
  todos: z
    .array(planTodoSchema)
    .min(1)
    .describe("Ordered list of concrete steps you will execute once approved."),
  requiredCapabilities: z
    .array(
      z.enum([
        "artifact-write",
        "warehouse-write",
        "git-write",
        "schedule-write",
      ]),
    )
    .optional()
    .describe(
      "Task-scoped mutation capabilities this plan needs. Include only those " +
        "the plan visibly describes. Desktop ACP enforces this list after approval.",
    ),
});

/**
 * Client-side plan-lifecycle tools (no execute = handled in the browser).
 */
export const clientPlanTools = {
  ask_clarifying_questions: tool({
    description:
      "Pause and ask the user one or more targeted clarifying questions before planning or acting. " +
      "Use this whenever the request is ambiguous or you need a decision (which connection, " +
      "which dashboard, scope, etc.). The user answers in an inline form; their answers are returned to you. " +
      "This is the ONLY way to ask the user questions — never present questions or option lists " +
      "as plain text in a reply. Prefer 'choice' questions with concrete options over free text. " +
      "When one option is the best default, set 'recommendedOption' to its exact label so the form " +
      "badges it as 'Recommended'. " +
      "Only ask what you genuinely need — do not ask questions you can answer with read-only tools.",
    inputSchema: askClarifyingQuestionsSchema,
    // No execute function - resolved by the client via an interactive form.
  }),

  submit_plan: tool({
    description:
      "Present a concrete, reviewable plan to the user for approval BEFORE acting, when the work is " +
      "large, destructive, or spans multiple artifacts (or the user asked for a plan). Clarify and explore " +
      "with read-only tools first so the plan is concrete. The user can Approve (which unlocks mutating " +
      "tools so you can execute), Request changes (returns feedback for you to revise the plan), or Cancel. " +
      "IMPORTANT: once you call this, mutating tools are blocked until the user approves.",
    inputSchema: submitPlanSchema,
    // No execute function - resolved by the client via the plan card.
  }),
};

export type ClarifyingQuestion = z.infer<typeof clarifyingQuestionSchema>;
export type AskClarifyingQuestionsInput = z.infer<
  typeof askClarifyingQuestionsSchema
>;
export type PlanTodo = z.infer<typeof planTodoSchema>;
export type SubmitPlanInput = z.infer<typeof submitPlanSchema>;

/** Shape the client returns for `ask_clarifying_questions`. */
export interface AskClarifyingQuestionsOutput {
  success: boolean;
  skipped?: boolean;
  answers?: Array<{
    id: string;
    prompt: string;
    response: string | string[];
  }>;
}

/** Decision the user can make on a submitted plan. */
export type PlanDecision = "approve" | "request_changes" | "cancel";

/** Shape the client returns for `submit_plan`. */
export interface SubmitPlanOutput {
  success: boolean;
  decision: PlanDecision;
  feedback?: string;
  editedPlan?: {
    title: string;
    planMarkdown: string;
    todos: PlanTodo[];
  };
}
