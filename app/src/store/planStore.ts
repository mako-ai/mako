/**
 * Plan Store
 *
 * State for the deferred `submit_plan` agent tool (Cursor-style plan review).
 * Each pending plan is keyed by its toolCallId and carries an editable draft
 * (title / markdown / todos) that round-trips back to the agent through the
 * `editedPlan` field of SubmitPlanOutput when the user approves or requests
 * changes.
 *
 * The resolver registry lives in module scope (NOT in store state) so it is
 * never persisted; the draft slice persists to localStorage so unapproved
 * edits survive a page reload. After a reload the resolver re-registers from
 * Chat.tsx's pending-tool scan, same as the docked card today.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type {
  PlanDecision,
  PlanTodo,
  SubmitPlanInput,
  SubmitPlanOutput,
} from "@mako/agent-tools";
import { useConsoleStore } from "./consoleStore";

export interface PlanDraft {
  title: string;
  planMarkdown: string;
  todos: PlanTodo[];
}

export type PlanStatus = "pending" | PlanDecision;

/** Display label for a plan decision (chips in the card and document tab). */
export const DECISION_LABEL: Record<PlanDecision, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  cancel: "Cancelled",
};

/** Chip color for a plan decision. */
export const DECISION_COLOR: Record<
  PlanDecision,
  "success" | "warning" | "default"
> = {
  approve: "success",
  request_changes: "warning",
  cancel: "default",
};

export interface PlanEntry {
  chatId: string;
  input: SubmitPlanInput;
  draft: PlanDraft;
  status: PlanStatus;
  output?: SubmitPlanOutput;
}

type PlanResolver = (output: SubmitPlanOutput) => void;

/** In-memory only — a deferred tool can only be resolved by the live useChat
 * instance, so resolvers never survive a reload (and must not be persisted). */
const resolvers = new Map<string, PlanResolver>();

interface PlanState {
  plans: Record<string, PlanEntry>;
}

interface PlanActions {
  /** Idempotent: never clobbers an existing draft (it may hold user edits). */
  registerPlan: (
    toolCallId: string,
    chatId: string,
    input: SubmitPlanInput,
  ) => void;
  setDraftTitle: (toolCallId: string, title: string) => void;
  setDraftMarkdown: (toolCallId: string, planMarkdown: string) => void;
  updateTodo: (toolCallId: string, index: number, content: string) => void;
  addTodo: (toolCallId: string) => void;
  removeTodo: (toolCallId: string, index: number) => void;
  registerResolver: (toolCallId: string, resolver: PlanResolver) => void;
  /** Resolve the deferred tool with the current draft as `editedPlan`
   * (omitted on cancel, matching the original PlanCard behavior). */
  resolvePlan: (
    toolCallId: string,
    decision: PlanDecision,
    feedback?: string,
  ) => void;
  /** Hydrate an already-resolved plan from message history (reload / old
   * chats). Idempotent and safe to call from effects. */
  markResolved: (toolCallId: string, output: SubmitPlanOutput) => void;
}

type PlanStore = PlanState & PlanActions;

const draftFromInput = (input: SubmitPlanInput): PlanDraft => ({
  title: input.title,
  planMarkdown: input.planMarkdown,
  todos: input.todos.map(t => ({ status: "pending" as const, ...t })),
});

export const usePlanStore = create<PlanStore>()(
  persist(
    immer((set, get) => ({
      plans: {},

      registerPlan: (toolCallId, chatId, input) => {
        if (get().plans[toolCallId]) return;
        set(state => {
          state.plans[toolCallId] = {
            chatId,
            input,
            draft: draftFromInput(input),
            status: "pending",
          };
        });
      },

      setDraftTitle: (toolCallId, title) =>
        set(state => {
          const plan = state.plans[toolCallId];
          if (!plan || plan.status !== "pending") return;
          plan.draft.title = title;
        }),

      setDraftMarkdown: (toolCallId, planMarkdown) =>
        set(state => {
          const plan = state.plans[toolCallId];
          if (!plan || plan.status !== "pending") return;
          plan.draft.planMarkdown = planMarkdown;
        }),

      updateTodo: (toolCallId, index, content) =>
        set(state => {
          const plan = state.plans[toolCallId];
          if (!plan || plan.status !== "pending") return;
          const todo = plan.draft.todos[index];
          if (!todo) return;
          todo.content = content;
        }),

      addTodo: toolCallId =>
        set(state => {
          const plan = state.plans[toolCallId];
          if (!plan || plan.status !== "pending") return;
          plan.draft.todos.push({ content: "", status: "pending" });
        }),

      removeTodo: (toolCallId, index) =>
        set(state => {
          const plan = state.plans[toolCallId];
          if (!plan || plan.status !== "pending") return;
          plan.draft.todos.splice(index, 1);
        }),

      registerResolver: (toolCallId, resolver) => {
        resolvers.set(toolCallId, resolver);
      },

      resolvePlan: (toolCallId, decision, feedback) => {
        const plan = get().plans[toolCallId];
        if (!plan || plan.status !== "pending") return;
        const resolver = resolvers.get(toolCallId);
        if (!resolver) return;

        const output: SubmitPlanOutput = {
          success: true,
          decision,
          ...(decision === "request_changes" && feedback ? { feedback } : {}),
          ...(decision !== "cancel"
            ? {
                editedPlan: {
                  title: plan.draft.title,
                  planMarkdown: plan.draft.planMarkdown,
                  // Clone out of the (frozen) immer state before handing the
                  // payload to the AI SDK.
                  todos: plan.draft.todos.map(t => ({ ...t })),
                },
              }
            : {}),
        };

        resolver(output);
        resolvers.delete(toolCallId);

        set(state => {
          const entry = state.plans[toolCallId];
          if (!entry) return;
          entry.status = decision;
          entry.output = output;
        });
      },

      markResolved: (toolCallId, output) => {
        const existing = get().plans[toolCallId];
        if (existing && existing.status !== "pending") return;
        resolvers.delete(toolCallId);
        set(state => {
          const entry = state.plans[toolCallId];
          if (!entry) return;
          entry.status = output.decision;
          entry.output = output;
          if (output.editedPlan) {
            entry.draft = {
              title: output.editedPlan.title,
              planMarkdown: output.editedPlan.planMarkdown,
              todos: output.editedPlan.todos.map(t => ({ ...t })),
            };
          }
        });
      },
    })),
    {
      name: "plan-store",
      // Only pending drafts need to survive a reload; resolved plans rehydrate
      // from message history via markResolved. Resolvers live outside state.
      partialize: state => ({
        plans: Object.fromEntries(
          Object.entries(state.plans).filter(
            ([, plan]) => plan.status === "pending",
          ),
        ),
      }),
    },
  ),
);

/** Deterministic tab id so opening a plan is idempotent across reloads. */
export const planTabId = (toolCallId: string) => `plan-${toolCallId}`;

/**
 * Open (or focus) the main-view document tab for a plan. Follows the same
 * dedupe pattern as consoleStore.loadConsole: focus the existing tab if open.
 */
export function focusPlanTab(
  toolCallId: string,
  chatId: string,
  title: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const id = planTabId(toolCallId);
  if (consoleStore.tabs[id]) {
    consoleStore.setActiveTab(id);
    return id;
  }
  consoleStore.openTab({
    id,
    title: title || "Plan",
    content: "",
    kind: "plan",
    // Saved + dirty so the tab is never auto-saved as a console nor replaced
    // as a pristine placeholder when another tab opens.
    isSaved: true,
    isDirty: true,
    metadata: { toolCallId, chatId },
  });
  return id;
}
