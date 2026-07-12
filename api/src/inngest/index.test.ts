import { afterAll, describe, expect, it } from "vitest";
import { appsV2MaintenanceFunction, getFunctions } from "./index";

const previousNodeEnvironment = process.env.NODE_ENV;
const previousDisableScheduledSync = process.env.DISABLE_SCHEDULED_SYNC;

afterAll(() => {
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDisableScheduledSync === undefined) {
    delete process.env.DISABLE_SCHEDULED_SYNC;
  } else {
    process.env.DISABLE_SCHEDULED_SYNC = previousDisableScheduledSync;
  }
});

describe("Inngest function registration", () => {
  it("does not register Apps v2 maintenance outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DISABLE_SCHEDULED_SYNC;

    expect(getFunctions()).not.toContain(appsV2MaintenanceFunction);
  });
});
