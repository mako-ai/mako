import { describe, expect, it } from "vitest";
import { clampAutoName, flowNameForSave } from "./flow-auto-name";
import { objectNameError } from "./object-name-rules";

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

  it("an auto name is one the server accepts: control characters become spaces, a long one is shortened with an ellipsis", () => {
    const long = `${"S".repeat(150)} \u2192 ${"D".repeat(150)}`;
    const name = flowNameForSave({
      existingName: undefined,
      previousAutoName: undefined,
      nextAutoName: long,
    });
    expect(name).toHaveLength(200);
    expect(name?.endsWith("\u2026")).toBe(true);
    expect(objectNameError("flow", name ?? "")).toBeNull();
    expect(clampAutoName("Close\tCRM \u2192 BQ")).toBe("Close CRM \u2192 BQ");
    // A stored name that IS the clamped auto name is still "never set":
    // a new selection may replace it.
    expect(
      flowNameForSave({
        existingName: name,
        previousAutoName: long,
        nextAutoName: "Stripe \u2192 Warehouse",
      }),
    ).toBe("Stripe \u2192 Warehouse");
    // Never cuts an emoji in half.
    const emoji = clampAutoName("\u{1F600}".repeat(150));
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect(objectNameError("flow", emoji)).toBeNull();
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
  });
});
