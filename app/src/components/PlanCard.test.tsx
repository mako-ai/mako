// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubmitPlanInput, SubmitPlanOutput } from "@mako/agent-tools";
import { PlanCard } from "./PlanCard";
import { usePlanStore } from "../store/planStore";
import { useUIStore } from "../store/uiStore";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../hooks/useIsMobile", () => ({
  useIsMobile: () => mobile.value,
  default: () => mobile.value,
}));

describe("PlanCard with unvalidated ACP input", () => {
  beforeEach(() => {
    usePlanStore.setState({ plans: {} });
    localStorage.clear();
  });
  afterEach(cleanup);

  it("renders the crash repro (submit_plan without todos) instead of throwing", () => {
    // Exact shape behind "Cannot read properties of undefined (reading 'length')".
    const malformed = {
      title: "Seller Contact app",
      planMarkdown: "# Plan",
    } as unknown as SubmitPlanInput;

    render(<PlanCard toolCallId="tc-1" chatId="chat-1" input={malformed} />);

    expect(screen.getByText("Seller Contact app")).toBeTruthy();
    expect(screen.getByText(/0 steps/)).toBeTruthy();
  });

  it("degrades to a placeholder title on fully garbage input and output", () => {
    render(
      <PlanCard
        toolCallId="tc-2"
        chatId="chat-1"
        input={{ title: 42, todos: "nope" } as unknown as SubmitPlanInput}
        output={{ decision: "bogus" } as unknown as SubmitPlanOutput}
      />,
    );

    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText(/0 steps/)).toBeTruthy();
    // Garbage decision → still treated as pending (approve action visible).
    expect(screen.getByText(/Approve/)).toBeTruthy();
  });
});

describe("PlanCard on mobile", () => {
  beforeEach(() => {
    usePlanStore.setState({ plans: {} });
    useUIStore.getState().setMobileTab("ask");
  });
  afterEach(() => {
    mobile.value = false;
    cleanup();
  });

  const input = {
    title: "Add PL market",
    planMarkdown: "# Plan",
    todos: [],
  } as unknown as SubmitPlanInput;

  it("surfaces the View tab when the card is tapped", () => {
    mobile.value = true;
    render(<PlanCard toolCallId="tc-m" chatId="chat-1" input={input} />);

    fireEvent.click(screen.getByText("Add PL market"));

    expect(useUIStore.getState().mobileTab).toBe("view");
  });

  it("does not touch the mobile tab on desktop", () => {
    render(<PlanCard toolCallId="tc-d" chatId="chat-1" input={input} />);

    fireEvent.click(screen.getByText("Add PL market"));

    expect(useUIStore.getState().mobileTab).toBe("ask");
  });
});
