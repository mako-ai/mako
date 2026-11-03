import { describe, expect, it } from "vitest";
import { describeCron, inTime, nextRunOf } from "./cronText";

describe("describeCron", () => {
  it("names set times on set days", () => {
    expect(describeCron("10 6-18/3 * * 1-5")).toBe(
      "Weekdays at 06:10, 09:10, 12:10, 15:10, 18:10 UTC",
    );
    expect(describeCron("0 8 * * *")).toBe("Every day at 08:00 UTC");
    expect(describeCron("30 7 * * 1,3")).toBe("Mon, Wed at 07:30 UTC");
    expect(describeCron("0 9 * * 0,6")).toBe("Weekends at 09:00 UTC");
  });

  it("says how often when it runs often", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every day, every 15 minutes");
    expect(describeCron("5 * * * 1-5")).toBe("Weekdays, every hour at :05");
    expect(describeCron("0 0-23/2 * * *")).toBe(
      "Every day, 12 times a day (00:00 to 22:00 UTC)",
    );
  });

  it("keeps the cron when it is unusual or wrong", () => {
    expect(describeCron("0 8 1 * *")).toBe("0 8 1 * * (UTC)");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("nextRunOf", () => {
  it("finds the next time in UTC", () => {
    const from = new Date("2026-10-22T07:00:00Z"); // a Thursday
    expect(nextRunOf("10 6-18/3 * * 1-5", from)?.toISOString()).toBe(
      "2026-10-22T09:10:00.000Z",
    );
    expect(nextRunOf("nope", from)).toBeNull();
  });
});

describe("inTime", () => {
  it("says how far away a time is", () => {
    const now = new Date("2026-10-22T07:00:00Z");
    expect(inTime(new Date("2026-10-22T07:45:00Z"), now)).toBe("in 45m");
    expect(inTime(new Date("2026-10-22T09:10:00Z"), now)).toBe("in 2h 10m");
    expect(inTime(new Date("2026-10-22T09:00:00Z"), now)).toBe("in 2h");
    expect(inTime(new Date("2026-10-26T08:00:00Z"), now)).toBe("in 4d");
  });
});
