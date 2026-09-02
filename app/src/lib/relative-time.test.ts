import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("rounds to the nearest sensible unit", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * MIN), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2 h ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeTime(ago(31 * DAY), NOW)).toBe("a month ago");
    expect(relativeTime(ago(95 * DAY), NOW)).toBe("3 months ago");
  });

  it("never reports the future", () => {
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe("just now");
  });
});
