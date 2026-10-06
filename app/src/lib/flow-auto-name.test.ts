import { describe, expect, it } from "vitest";
import { flowNameForSave } from "./flow-auto-name";

describe("flowNameForSave", () => {
  it("names a new flow automatically", () => {
    expect(
      flowNameForSave({
        existingName: undefined,
        previousAutoName: undefined,
        nextAutoName: "Stripe → Warehouse",
      }),
    ).toBe("Stripe → Warehouse");
  });

  it("keeps following the selections while the name was never set by a person", () => {
    expect(
      flowNameForSave({
        existingName: "Stripe → Warehouse",
        previousAutoName: "Stripe → Warehouse",
        nextAutoName: "Stripe → BigQuery",
      }),
    ).toBe("Stripe → BigQuery");
    // Unchanged selections: nothing to say about the name, even when it
    // looks auto-named — the store may be stale (renamed elsewhere).
    expect(
      flowNameForSave({
        existingName: "Stripe → Warehouse",
        previousAutoName: "Stripe → Warehouse",
        nextAutoName: "Stripe → Warehouse",
      }),
    ).toBeUndefined();
    expect(
      flowNameForSave({
        existingName: "  ",
        previousAutoName: "x",
        nextAutoName: "Stripe → BigQuery",
      }),
    ).toBe("Stripe → BigQuery");
  });

  it("never overwrites a name a person set (the bug this exists for)", () => {
    expect(
      flowNameForSave({
        existingName: "Billing sync",
        previousAutoName: "Stripe → Warehouse",
        nextAutoName: "Stripe → Warehouse",
      }),
    ).toBeUndefined();
    // Even when it looks like an auto name for OTHER selections.
    expect(
      flowNameForSave({
        existingName: "Close → Warehouse",
        previousAutoName: "Stripe → Warehouse",
        nextAutoName: "Stripe → Warehouse",
      }),
    ).toBeUndefined();
  });
});
