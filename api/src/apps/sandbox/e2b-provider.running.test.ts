/**
 * The E2B "running?" lookup behind the apps files/status routes, bounded
 * after 2026-11-16 (a slow list held repo-work pool slots):
 *
 * - a list that does not answer in 3 s gives up;
 * - it then answers "unknown" (polls read that as "not running"), never a
 *   stale answer;
 * - concurrent lookups of one session share one list call;
 * - a failure is logged, not swallowed.
 *
 * The e2b SDK is a mock; timers are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("e2b", () => ({ Sandbox: { list: sdk.list } }));

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../logging", async importOriginal => {
  const actual = await importOriginal<typeof import("../../logging")>();
  return {
    ...actual,
    loggers: {
      ...actual.loggers,
      api: (name: string) => {
        const real = actual.loggers.api(name);
        return name === "apps-e2b" ? { ...real, warn } : real;
      },
    },
  };
});

import {
  RUNNING_LOOKUP_TIMEOUT_MS,
  e2bSandboxProvider,
  resetE2bProviderStateForTests,
} from "./e2b-provider";

const KEY = "6846e6a01b05af0948070582:6846e6a01b05af0948070999";

function page(items: unknown[], delayMs = 0) {
  let done = false;
  return {
    get hasNext() {
      return !done;
    },
    nextItems: () =>
      new Promise(resolve => {
        const answer = () => {
          done = true;
          resolve(items);
        };
        if (delayMs === 0) answer();
        else setTimeout(answer, delayMs);
      }),
  };
}
const never = () => ({ hasNext: true, nextItems: () => new Promise(() => {}) });

const runState = (fresh: boolean) =>
  e2bSandboxProvider.runState!({ sessionKey: KEY }, { fresh });

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  resetE2bProviderStateForTests();
  process.env.E2B_API_KEY = "test-key";
});
afterEach(() => vi.useRealTimers());

describe("E2B running lookup", () => {
  it("gives up after the timeout with no known answer: unknown, logged", async () => {
    sdk.list.mockReturnValue(never());
    const state = runState(true);
    await vi.advanceTimersByTimeAsync(RUNNING_LOOKUP_TIMEOUT_MS);
    expect(await state).toBe("unknown");
    expect(RUNNING_LOOKUP_TIMEOUT_MS).toBe(3_000);
    expect(warn).toHaveBeenCalledWith(
      "E2B running lookup failed",
      expect.objectContaining({ sessionKey: KEY }),
    );
    // The SDK's own request timeout is set too.
    expect(sdk.list).toHaveBeenCalledWith(
      expect.objectContaining({ requestTimeoutMs: RUNNING_LOOKUP_TIMEOUT_MS }),
    );
  });

  it("a failed lookup is unknown for polls and fresh callers alike, never a stale answer", async () => {
    sdk.list.mockReturnValueOnce(page([{ sandboxId: "sbx-1" }]));
    expect(await runState(true)).toBe("running");

    // Past the 10 s cache a poll asks E2B again, and the call fails. A
    // stale "running" would let a poll guard exec and resume a paused box.
    await vi.advanceTimersByTimeAsync(11_000);
    sdk.list.mockImplementationOnce(() => {
      throw new Error("E2B 500");
    });
    expect(await runState(false)).toBe("unknown");
    // What a poll guard sees: not running, so it does not exec.
    sdk.list.mockImplementationOnce(() => {
      throw new Error("E2B 500");
    });
    expect(await e2bSandboxProvider.isRunning!({ sessionKey: KEY })).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      "E2B running lookup failed",
      expect.objectContaining({ sessionKey: KEY, error: "E2B 500" }),
    );

    sdk.list.mockImplementationOnce(() => {
      throw new Error("E2B 500");
    });
    expect(await runState(true)).toBe("unknown");
  });

  it("coalesces concurrent lookups of one session into one list call", async () => {
    sdk.list.mockReturnValue(page([], 500));
    const all = Promise.all([runState(true), runState(true), runState(false)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(await all).toEqual(["not-running", "not-running", "not-running"]);
    expect(sdk.list).toHaveBeenCalledTimes(1);

    // Once it settled, a fresh lookup asks again.
    expect(
      await (async () => {
        const next = runState(true);
        await vi.advanceTimersByTimeAsync(500);
        return next;
      })(),
    ).toBe("not-running");
    expect(sdk.list).toHaveBeenCalledTimes(2);
  });
});
