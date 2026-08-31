import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatRelativeTime,
  formatRelativeTimeCompact,
  toDate,
} from "./relative-time";

const NOW = new Date("2026-08-31T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A timestamp `ms` before NOW, in the given input form. */
function ago(ms: number): number {
  return NOW.getTime() - ms;
}

describe("relative-time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("toDate", () => {
    it("accepts ISO strings, epoch millis and Date objects", () => {
      expect(toDate("2026-08-31T11:00:00Z")?.getTime()).toBe(ago(HOUR));
      expect(toDate(ago(HOUR))?.getTime()).toBe(ago(HOUR));
      expect(toDate(new Date(ago(HOUR)))?.getTime()).toBe(ago(HOUR));
    });

    it("is null for absent or unparseable input", () => {
      expect(toDate(undefined)).toBeNull();
      expect(toDate(null)).toBeNull();
      expect(toDate("")).toBeNull();
      expect(toDate("not a date")).toBeNull();
    });
  });

  describe("formatRelativeTime", () => {
    it("is null for absent or invalid input", () => {
      expect(formatRelativeTime(undefined)).toBeNull();
      expect(formatRelativeTime("nope")).toBeNull();
    });

    it("spells out minutes, hours and days", () => {
      expect(formatRelativeTime(ago(10_000))).toBe("just now");
      expect(formatRelativeTime(ago(5 * MIN))).toBe("5 min ago");
      expect(formatRelativeTime(ago(3 * HOUR))).toBe("3 hr ago");
      expect(formatRelativeTime(ago(DAY))).toBe("1 day ago");
      expect(formatRelativeTime(ago(2 * DAY))).toBe("2 days ago");
    });

    it("rolls days into months and years", () => {
      expect(formatRelativeTime(ago(29 * DAY))).toBe("29 days ago");
      expect(formatRelativeTime(ago(31 * DAY))).toBe("1 month ago");
      expect(formatRelativeTime(ago(90 * DAY))).toBe("3 months ago");
      expect(formatRelativeTime(ago(400 * DAY))).toBe("1 year ago");
      expect(formatRelativeTime(ago(800 * DAY))).toBe("2 years ago");
    });

    it("takes an ISO string like the data layer provides", () => {
      expect(formatRelativeTime(new Date(ago(3 * HOUR)).toISOString())).toBe(
        "3 hr ago",
      );
    });
  });

  describe("formatRelativeTimeCompact", () => {
    it("renders an em dash (or the given placeholder) for missing input", () => {
      expect(formatRelativeTimeCompact(undefined)).toBe("—");
      expect(formatRelativeTimeCompact("bad", { empty: "unknown" })).toBe(
        "unknown",
      );
    });

    it("uses single-letter units and floors", () => {
      expect(formatRelativeTimeCompact(ago(30_000))).toBe("just now");
      expect(formatRelativeTimeCompact(ago(90_000))).toBe("1m ago");
      expect(formatRelativeTimeCompact(ago(5 * HOUR + 59 * MIN))).toBe(
        "5h ago",
      );
      expect(formatRelativeTimeCompact(ago(40 * DAY))).toBe("40d ago");
    });

    it("switches to an absolute date after the given number of days", () => {
      const opts = { absoluteAfterDays: 7 };
      expect(formatRelativeTimeCompact(ago(6 * DAY), opts)).toBe("6d ago");
      const sameYear = formatRelativeTimeCompact(ago(40 * DAY), opts);
      expect(sameYear).toMatch(/^Jul 2\d$/);
      const lastYear = formatRelativeTimeCompact(ago(400 * DAY), opts);
      expect(lastYear).toMatch(/2025/);
    });
  });
});
