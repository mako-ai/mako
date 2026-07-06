import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { isStaleQueued } from "./dbt-run.service";

function run(overrides: Partial<Parameters<typeof isStaleQueued>[0]> = {}) {
  return {
    _id: new Types.ObjectId(),
    status: "queued",
    createdAt: new Date(0),
    ...overrides,
  } as Parameters<typeof isStaleQueued>[0];
}

describe("isStaleQueued", () => {
  const now = 1_000_000;
  const timeout = 1_000;

  it("is true for a queued run older than the timeout with no startedAt", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout - 1) }),
        now,
        timeout,
      ),
    ).toBe(true);
  });

  it("is false when still within the timeout window", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout + 1) }),
        now,
        timeout,
      ),
    ).toBe(false);
  });

  it("is false once the run has started (picked up by a worker)", () => {
    expect(
      isStaleQueued(
        run({ createdAt: new Date(now - timeout - 1), startedAt: new Date() }),
        now,
        timeout,
      ),
    ).toBe(false);
  });

  it("is false for any non-queued status", () => {
    for (const status of ["running", "success", "error", "cancelled"]) {
      expect(
        isStaleQueued(
          run({ status, createdAt: new Date(now - timeout - 1) }),
          now,
          timeout,
        ),
      ).toBe(false);
    }
  });

  it("is false when createdAt is missing (can't age it)", () => {
    expect(isStaleQueued(run({ createdAt: undefined }), now, timeout)).toBe(
      false,
    );
  });
});
