import { describe, expect, it } from "vitest";
import { isBindingDueAt } from "./apps-binding-refresh";

const daily = { schedule: "0 3 * * *", timezone: "UTC" };
const at = (iso: string) => new Date(iso);

describe("isBindingDueAt (binding history is newest-first)", () => {
  it("is due when it has never been attempted", () => {
    expect(isBindingDueAt(daily, null, at("2026-08-31T10:00:00Z"))).toBe(true);
  });

  it("reads the NEWEST attempt, not the oldest — a binding built this morning is not due again", () => {
    const state = {
      lastMaterializedAt: at("2026-08-31T09:11:00Z"),
      history: [
        { at: at("2026-08-31T09:11:00Z"), status: "ready" as const },
        { at: at("2026-08-30T01:30:00Z"), status: "ready" as const },
      ],
    };
    expect(isBindingDueAt(daily, state, at("2026-08-31T10:00:00Z"))).toBe(
      false,
    );
    expect(isBindingDueAt(daily, state, at("2026-09-01T03:01:00Z"))).toBe(true);
  });

  it("backs off from a failed attempt instead of retrying every tick", () => {
    const state = {
      lastMaterializedAt: at("2026-08-30T03:00:00Z"),
      history: [
        {
          at: at("2026-08-31T09:11:00Z"),
          status: "error" as const,
          error: "boom",
        },
        { at: at("2026-08-30T03:00:00Z"), status: "ready" as const },
      ],
    };
    expect(isBindingDueAt(daily, state, at("2026-08-31T09:30:00Z"))).toBe(
      false,
    );
  });

  it("a 15-minute binding is due again 15 minutes after its last attempt", () => {
    const state = {
      history: [{ at: at("2026-08-31T09:11:00Z"), status: "ready" as const }],
    };
    const q = { schedule: "*/15 * * * *", timezone: "UTC" };
    expect(isBindingDueAt(q, state, at("2026-08-31T09:14:00Z"))).toBe(false);
    expect(isBindingDueAt(q, state, at("2026-08-31T09:16:00Z"))).toBe(true);
  });

  it("is never due without a schedule", () => {
    expect(isBindingDueAt({ schedule: undefined }, null)).toBe(false);
  });
});
