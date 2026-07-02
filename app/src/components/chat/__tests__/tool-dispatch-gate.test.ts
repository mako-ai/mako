import { describe, it, expect, vi } from "vitest";
import { ToolDispatchGate } from "../tool-dispatch-gate";

describe("ToolDispatchGate", () => {
  it("allows the first dispatch and blocks replays of the same toolCallId", () => {
    const gate = new ToolDispatchGate();
    const execute = vi.fn();

    // Simulates the incident: the same tool-input-available chunk delivered to
    // multiple stream consumers / replayed by a resume reattach.
    for (let i = 0; i < 3; i++) {
      if (gate.markDispatched("call-1")) execute();
    }

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("tracks distinct toolCallIds independently", () => {
    const gate = new ToolDispatchGate();
    expect(gate.markDispatched("call-1")).toBe(true);
    expect(gate.markDispatched("call-2")).toBe(true);
    expect(gate.markDispatched("call-1")).toBe(false);
    expect(gate.markDispatched("call-2")).toBe(false);
  });

  it("always allows calls without a toolCallId (cannot dedupe)", () => {
    const gate = new ToolDispatchGate();
    expect(gate.markDispatched("")).toBe(true);
    expect(gate.markDispatched(undefined)).toBe(true);
    expect(gate.markDispatched(null)).toBe(true);
  });

  it("reset() forgets dispatched ids (chat switch)", () => {
    const gate = new ToolDispatchGate();
    gate.markDispatched("call-1");
    gate.reset();
    expect(gate.markDispatched("call-1")).toBe(true);
  });

  describe("seedFromPersistedMessages", () => {
    it("blocks ids persisted in a terminal state", () => {
      const gate = new ToolDispatchGate();
      gate.seedFromPersistedMessages([
        {
          role: "assistant",
          parts: [
            {
              type: "tool-create_dashboard",
              toolCallId: "done-1",
              state: "output-available",
            },
            {
              type: "dynamic-tool",
              toolName: "create_data_source",
              toolCallId: "done-2",
              state: "output-error",
            },
            { type: "tool-run_console", toolCallId: "err-1", state: "error" },
          ],
        },
      ]);
      expect(gate.markDispatched("done-1")).toBe(false);
      expect(gate.markDispatched("done-2")).toBe(false);
      expect(gate.markDispatched("err-1")).toBe(false);
    });

    it("keeps non-terminal (interrupted) ids dispatchable for post-refresh recovery", () => {
      const gate = new ToolDispatchGate();
      gate.seedFromPersistedMessages([
        {
          role: "assistant",
          parts: [
            {
              type: "tool-create_dashboard",
              toolCallId: "pending-1",
              state: "input-available",
            },
            {
              type: "tool-add_widget",
              toolCallId: "pending-2",
              state: "input-streaming",
            },
          ],
        },
      ]);
      // First (replay-driven) dispatch is allowed, subsequent ones are blocked.
      expect(gate.markDispatched("pending-1")).toBe(true);
      expect(gate.markDispatched("pending-1")).toBe(false);
      expect(gate.markDispatched("pending-2")).toBe(true);
    });

    it("ignores non-tool parts and parts without ids", () => {
      const gate = new ToolDispatchGate();
      gate.seedFromPersistedMessages([
        {
          role: "assistant",
          parts: [
            { type: "text", text: "hello" },
            { type: "step-start" },
            { type: "tool-run_console", state: "output-available" },
            { type: "reasoning", reasoning: "hmm" },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: null },
      ]);
      expect(gate.markDispatched("anything")).toBe(true);
    });
  });
});
