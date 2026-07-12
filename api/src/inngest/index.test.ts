import { afterAll, describe, expect, it } from "vitest";
import {
  appsV2MaintenanceFunction,
  flowSchedulerFunction,
  getFunctions,
} from "./index";

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
  it("keeps Apps v2 maintenance active in production previews", () => {
    process.env.NODE_ENV = "production";
    process.env.DISABLE_SCHEDULED_SYNC = "true";

    expect(getFunctions()).toContain(appsV2MaintenanceFunction);
    expect(getFunctions()).not.toContain(flowSchedulerFunction);
  });
});
