/**
 * InngestDriver — the mapping onto Inngest step tools, without a server:
 *
 *   - run(): results are boxed so null/undefined survive; a step at its retry
 *     limit (or a non-retryable error) becomes NonRetriableError, otherwise
 *     the error is rethrown for Inngest to retry;
 *   - waitForSignal(): check → waitForEvent (CEL on runId + key) → re-read,
 *     and a satisfied check skips the wait entirely.
 *
 * End-to-end behaviour against a real Inngest dev server was verified
 * manually (see PROCESS_PLATFORM_DESIGN.md §14).
 */
import { describe, expect, it } from "vitest";
import { NonRetriableError } from "inngest";
import { InngestDriver } from "./inngest-engine";
import { NonRetryableStepError } from "./driver";

function fakeStep() {
  const calls: Array<{ op: string; id: string; opts?: unknown }> = [];
  return {
    calls,
    tools: {
      run: async <T>(id: string, fn: () => Promise<T>) => {
        calls.push({ op: "run", id });
        return JSON.parse(JSON.stringify(await fn()));
      },
      sleepUntil: async (id: string) => {
        calls.push({ op: "sleepUntil", id });
      },
      waitForEvent: async (id: string, opts: unknown) => {
        calls.push({ op: "waitForEvent", id, opts });
        return { name: "process/signal" };
      },
    },
  };
}

describe("InngestDriver", () => {
  it("round-trips undefined and null step results", async () => {
    const step = fakeStep();
    const driver = new InngestDriver(step.tools, 0, "run1");
    expect(
      await driver.run("a", async () => undefined, { retries: 3 }),
    ).toBeUndefined();
    expect(await driver.run("b", async () => null, { retries: 3 })).toBeNull();
    expect(
      await driver.run("c", async () => ({ x: 1 }), { retries: 3 }),
    ).toEqual({ x: 1 });
  });

  it("lets Inngest retry until the step's own limit, then stops", async () => {
    const boom = async () => {
      throw new Error("flaky");
    };
    await expect(
      new InngestDriver(fakeStep().tools, 1, "r").run("s", boom, {
        retries: 3,
      }),
    ).rejects.not.toBeInstanceOf(NonRetriableError);
    await expect(
      new InngestDriver(fakeStep().tools, 3, "r").run("s", boom, {
        retries: 3,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    await expect(
      new InngestDriver(fakeStep().tools, 0, "r").run(
        "s",
        async () => {
          throw new NonRetryableStepError("ledger says no");
        },
        { retries: 3 },
      ),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("checks before waiting, waits on a run+key filter, then re-reads", async () => {
    const step = fakeStep();
    const driver = new InngestDriver(step.tools, 0, "run-42");
    let state: string | null = null;
    const result = await driver.waitForSignal("approve", {
      signalKey: "approve",
      timeoutAt: new Date(Date.now() + 60_000),
      check: async () => {
        const value = state;
        state = "approved"; // the decision lands while we wait
        return value;
      },
    });
    expect(result).toBe("approved");
    expect(step.calls.map(c => `${c.op}:${c.id}`)).toEqual([
      "run:approve:check",
      "waitForEvent:approve:signal",
      "run:approve:read",
    ]);
    expect((step.calls[1].opts as { if: string }).if).toBe(
      'async.data.runId == "run-42" && async.data.key == "approve"',
    );
  });

  it("skips the wait when the check is already satisfied", async () => {
    const step = fakeStep();
    const driver = new InngestDriver(step.tools, 0, "r");
    const result = await driver.waitForSignal("x", {
      signalKey: "x",
      timeoutAt: new Date(),
      check: async () => "done",
    });
    expect(result).toBe("done");
    expect(step.calls.map(c => c.op)).toEqual(["run"]);
  });
});
