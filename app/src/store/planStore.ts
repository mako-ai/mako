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

/** Progressively-parsed partial input while the model streams submit_plan
 * arguments — every field may be undefined or truncated mid-stream. */
export interface PartialSubmitPlanInput {
  title?: string;
  planMarkdown?: string;
  todos?: Array<Partial<PlanTodo> | undefined>;
}

export type PlanStatus = "streaming" | "pending" | PlanDecision;

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
  /** Overwrite the draft from the partial tool input while the model is still
   * writing the plan. No-ops once the plan has left the "streaming" state so a
   * late delta can never clobber the finalized draft. */
  setStreamingInput: (
    toolCallId: string,
    chatId: string,
    partial: PartialSubmitPlanInput | undefined,
  ) => void;
  /** Finalize to "pending" with the complete input as the draft baseline.
   * Idempotent once pending/resolved: never clobbers user edits. */
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
   * (omitted on cancel, matching the original PlanCard behavior). Returns
   * false when the plan is not pending or no live resolver is registered. */
  resolvePlan: (
    toolCallId: string,
    decision: PlanDecision,
    feedback?: string,
  ) => boolean;
  /** Hydrate an already-resolved plan from message history (reload / old
   * chats). Idempotent and safe to call from effects. */
  markResolved: (toolCallId: string, output: SubmitPlanOutput) => void;
}

type PlanStore = PlanState & PlanActions;

const TODO_STATUSES = new Set<PlanTodo["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

const CAPABILITY_GRANTS = new Set([
  "artifact-write",
  "warehouse-write",
  "git-write",
  "schedule-write",
]);

const normalizeTodos = (todos: unknown): PlanTodo[] => {
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((t): t is Partial<PlanTodo> => Boolean(t) && typeof t === "object")
    .map(t => ({
      ...(typeof t.id === "string" ? { id: t.id } : {}),
      content: typeof t.content === "string" ? t.content : "",
      status: TODO_STATUSES.has(t.status as PlanTodo["status"])
        ? (t.status as PlanTodo["status"])
        : ("pending" as const),
    }));
};

/**
 * Desktop ACP forwards raw agent tool arguments with no schema validation
 * (mako-desktop MCP → bridge job → renderer), so any field may be missing or
 * of the wrong type. Coerce to a well-formed SubmitPlanInput so a malformed
 * plan can never crash the plan card / tab (top-level display error).
 */
export const normalizeSubmitPlanInput = (input: unknown): SubmitPlanInput => {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<
    Record<keyof SubmitPlanInput, unknown>
  >;
  const requiredCapabilities = Array.isArray(raw.requiredCapabilities)
    ? (raw.requiredCapabilities.filter(
        g => typeof g === "string" && CAPABILITY_GRANTS.has(g),
      ) as SubmitPlanInput["requiredCapabilities"])
    : undefined;
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    planMarkdown: typeof raw.planMarkdown === "string" ? raw.planMarkdown : "",
    todos: normalizeTodos(raw.todos),
    ...(requiredCapabilities?.length ? { requiredCapabilities } : {}),
  };
};

const draftFromInput = (input: SubmitPlanInput): PlanDraft => ({
  title: input.title,
  planMarkdown: input.planMarkdown,
  todos: (input.todos ?? []).map(t => ({ status: "pending" as const, ...t })),
});

const draftFromPartialInput = (
  partial: PartialSubmitPlanInput | undefined,
): PlanDraft => ({
  title: typeof partial?.title === "string" ? partial.title : "",
  planMarkdown:
    typeof partial?.planMarkdown === "string" ? partial.planMarkdown : "",
  todos: (Array.isArray(partial?.todos) ? partial.todos : [])
    .filter((t): t is Partial<PlanTodo> => Boolean(t))
    .map(t => ({
      ...(typeof t.id === "string" ? { id: t.id } : {}),
      content: typeof t.content === "string" ? t.content : "",
      status: TODO_STATUSES.has(t.status as PlanTodo["status"])
        ? (t.status as PlanTodo["status"])
        : ("pending" as const),
    })),
});

export const usePlanStore = create<PlanStore>()(
  persist(
    immer((set, get) => ({
      plans: {},

      setStreamingInput: (toolCallId, chatId, partial) => {
        const existing = get().plans[toolCallId];
        if (existing && existing.status !== "streaming") return;
        set(state => {
          const draft = draftFromPartialInput(partial);
          state.plans[toolCallId] = {
            chatId,
            input: {
              title: draft.title,
              planMarkdown: draft.planMarkdown,
              todos: draft.todos,
            },
            draft,
            status: "streaming",
          };
        });
      },

      registerPlan: (toolCallId, chatId, input) => {
        const existing = get().plans[toolCallId];
        // Streaming → pending always resets the draft from the final input so
        // a half-streamed plan is never persisted as a user draft; once
        // pending, user edits are preserved.
        if (existing && existing.status !== "streaming") return;
        // ACP bridge input is unvalidated — never trust the shape.
        const safe = normalizeSubmitPlanInput(input);
        set(state => {
          state.plans[toolCallId] = {
            chatId,
            input: safe,
            draft: draftFromInput(safe),
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
        if (!plan || plan.status !== "pending") return false;
        const resolver = resolvers.get(toolCallId);
        if (!resolver) return false;

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
        return true;
      },

      markResolved: (toolCallId, output) => {
        const existing = get().plans[toolCallId];
        if (
          existing &&
          existing.status !== "pending" &&
          existing.status !== "streaming"
        ) {
          return;
        }
        // ACP outputs are unvalidated (coerced MCP text) — ignore garbage.
        if (
          output.decision !== "approve" &&
          output.decision !== "request_changes" &&
          output.decision !== "cancel"
        ) {
          return;
        }
        resolvers.delete(toolCallId);
        set(state => {
          const entry = state.plans[toolCallId];
          if (!entry) return;
          entry.status = output.decision;
          entry.output = output;
          if (output.editedPlan && typeof output.editedPlan === "object") {
            entry.draft = {
              title:
                typeof output.editedPlan.title === "string"
                  ? output.editedPlan.title
                  : entry.draft.title,
              planMarkdown:
                typeof output.editedPlan.planMarkdown === "string"
                  ? output.editedPlan.planMarkdown
                  : entry.draft.planMarkdown,
              todos:
                output.editedPlan.todos === undefined
                  ? entry.draft.todos
                  : normalizeTodos(output.editedPlan.todos),
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

/**
 * Deterministic tab id. One plan tab per chat: when the model revises a plan
 * after feedback (new toolCallId), the revision replaces the same tab instead
 * of stacking a new one. Falls back to a per-toolCallId id when the chat is
 * unknown (e.g. summaries of old plans with no registered entry).
 */
export const planTabId = (toolCallId: string, chatId: string) =>
  chatId ? `plan-chat-${chatId}` : `plan-${toolCallId}`;

/**
 * Open (or focus) the main-view document tab for a plan. Follows the same
 * dedupe pattern as consoleStore.loadConsole: focus the existing tab if it
 * already shows this toolCallId; re-point it (openTab with the same id
 * overwrites title + metadata) when a plan revision arrives.
 */
export function focusPlanTab(
  toolCallId: string,
  chatId: string,
  title: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const id = planTabId(toolCallId, chatId);
  const existing = consoleStore.tabs[id];
  if (existing && existing.metadata?.toolCallId === toolCallId) {
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

/** Close the plan's main-view tab (no-op when it is not open or has been
 * re-pointed to a different toolCallId). Used when the user discards a
 * pending plan — the inline summary card in the chat history can re-open it
 * read-only. */
export function closePlanTab(toolCallId: string, chatId: string): void {
  const consoleStore = useConsoleStore.getState();
  const id = planTabId(toolCallId, chatId);
  const tab = consoleStore.tabs[id];
  if (!tab || tab.metadata?.toolCallId !== toolCallId) return;
  consoleStore.closeTab(id);
}

/** Keep the plan tab's title in sync as it streams/finalizes (no-op when the
 * tab is closed or the title is unchanged — cheap to call per delta). */
export function syncPlanTabTitle(
  toolCallId: string,
  chatId: string,
  title: string,
): void {
  if (!title) return;
  const id = planTabId(toolCallId, chatId);
  const tab = useConsoleStore.getState().tabs[id];
  if (!tab || tab.title === title || tab.metadata?.toolCallId !== toolCallId) {
    return;
  }
  useConsoleStore.setState(state => {
    const t = state.tabs[id];
    if (t) t.title = title;
  });
}
