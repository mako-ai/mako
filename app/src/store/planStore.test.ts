// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { SubmitPlanInput, SubmitPlanOutput } from "@mako/agent-tools";
import { normalizeSubmitPlanInput, usePlanStore } from "./planStore";

function resetPlanStore(): void {
  usePlanStore.setState({ plans: {} });
  localStorage.clear();
}

const validInput: SubmitPlanInput = {
  title: "Seller Contact app",
  planMarkdown: "# Plan\n\nBuild it.",
  todos: [{ content: "Worklist" }, { content: "Region view" }],
};

describe("normalizeSubmitPlanInput", () => {
  it("passes a valid input through", () => {
    expect(normalizeSubmitPlanInput(validInput)).toEqual({
      title: "Seller Contact app",
      planMarkdown: "# Plan\n\nBuild it.",
      todos: [
        { content: "Worklist", status: "pending" },
        { content: "Region view", status: "pending" },
      ],
    });
  });

  it("tolerates missing fields (unvalidated ACP bridge arguments)", () => {
    // The exact shape that crashed Desktop: submit_plan without todos.
    expect(
      normalizeSubmitPlanInput({ title: "Plan", planMarkdown: "# P" }),
    ).toEqual({ title: "Plan", planMarkdown: "# P", todos: [] });
    expect(normalizeSubmitPlanInput(undefined)).toEqual({
      title: "",
      planMarkdown: "",
      todos: [],
    });
    expect(normalizeSubmitPlanInput("not an object")).toEqual({
      title: "",
      planMarkdown: "",
      todos: [],
    });
  });

  it("drops mistyped fields and malformed todo entries", () => {
    expect(
      normalizeSubmitPlanInput({
        title: 42,
        planMarkdown: null,
        todos: [
          null,
          "step as string",
          { content: "Real step", status: "bogus" },
          { content: 7, id: 9 },
        ],
        requiredCapabilities: "artifact-write",
      }),
    ).toEqual({
      title: "",
      planMarkdown: "",
      todos: [
        { content: "Real step", status: "pending" },
        { content: "", status: "pending" },
      ],
    });
  });

  it("keeps only known capability grants", () => {
    expect(
      normalizeSubmitPlanInput({
        ...validInput,
        requiredCapabilities: ["artifact-write", "root-access", 3],
      }).requiredCapabilities,
    ).toEqual(["artifact-write"]);
  });
});

describe("planStore with malformed ACP input", () => {
  beforeEach(resetPlanStore);

  it("registerPlan never crashes on input without todos", () => {
    const malformed = {
      title: "Plan",
      planMarkdown: "# P",
    } as unknown as SubmitPlanInput;
    usePlanStore.getState().registerPlan("tc-1", "chat-1", malformed);
    const plan = usePlanStore.getState().plans["tc-1"];
    expect(plan?.status).toBe("pending");
    expect(plan?.draft.todos).toEqual([]);
    expect(plan?.input.todos).toEqual([]);
  });

  it("setStreamingInput tolerates a non-array todos delta", () => {
    usePlanStore.getState().setStreamingInput("tc-2", "chat-1", {
      title: "Plan",
      todos: "not-yet-parsed" as unknown as [],
    });
    expect(usePlanStore.getState().plans["tc-2"]?.draft.todos).toEqual([]);
  });

  it("markResolved ignores garbage decisions and missing editedPlan.todos", () => {
    usePlanStore.getState().registerPlan("tc-3", "chat-1", validInput);

    usePlanStore.getState().markResolved("tc-3", {
      success: true,
      decision: "42",
    } as unknown as SubmitPlanOutput);
    expect(usePlanStore.getState().plans["tc-3"]?.status).toBe("pending");

    usePlanStore.getState().markResolved("tc-3", {
      success: true,
      decision: "approve",
      editedPlan: { title: "Edited" },
    } as unknown as SubmitPlanOutput);
    const plan = usePlanStore.getState().plans["tc-3"];
    expect(plan?.status).toBe("approve");
    expect(plan?.draft.title).toBe("Edited");
    // editedPlan.todos omitted → keep the existing draft todos.
    expect(plan?.draft.todos).toHaveLength(2);
  });
});
