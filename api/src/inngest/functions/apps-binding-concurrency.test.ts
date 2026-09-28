/**
 * Scheduled and on-demand binding builds share ONE concurrency budget: the
 * same env-scoped keys in both functions, so a workspace sees at most 4
 * builds in total and a binding is never built twice at once.
 */
import { describe, expect, it } from "vitest";
import { APPS_BINDING_BUILD_CONCURRENCY } from "./apps-binding-concurrency";
import { appsBindingMaterializeFunction } from "./apps-binding-refresh";
import { appsBindingJobFunction } from "./apps-binding-job";

function concurrencyOf(fn: unknown): unknown {
  return (fn as { opts: { concurrency?: unknown } }).opts.concurrency;
}

describe("binding build concurrency", () => {
  it("is shared across functions (env scope, same key strings)", () => {
    for (const limit of APPS_BINDING_BUILD_CONCURRENCY) {
      expect(limit.scope).toBe("env");
      // A function-independent prefix: the key must evaluate to the same
      // string in both functions for the budget to be shared.
      expect(limit.key).toMatch(/^"apps-binding[-a-z]*:" \+ event\.data\./);
    }
    expect(APPS_BINDING_BUILD_CONCURRENCY.map(l => l.limit)).toEqual([4, 1]);
  });

  it("is what both the scheduler's worker and the async job use", () => {
    expect(concurrencyOf(appsBindingMaterializeFunction)).toBe(
      APPS_BINDING_BUILD_CONCURRENCY,
    );
    expect(concurrencyOf(appsBindingJobFunction)).toBe(
      APPS_BINDING_BUILD_CONCURRENCY,
    );
  });
});
