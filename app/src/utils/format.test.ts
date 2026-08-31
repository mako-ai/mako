import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatDuration", () => {
  it("renders missing or invalid input as an em dash, never empty", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });

  it("uses whole milliseconds under a second, no space before the unit", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(12.6)).toBe("13ms");
  });

  it("uses one decimal of seconds under a minute", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59_940)).toBe("59.9s");
  });

  it("splits minutes and seconds past a minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(119_600)).toBe("2m 0s");
    expect(formatDuration(3_600_000)).toBe("60m 0s");
  });
});

describe("formatBytes", () => {
  it("renders invalid input as an em dash", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
  });

  it("scales by 1024 with one decimal above bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12.0 MB");
    expect(formatBytes(3.8 * 1024 ** 3)).toBe("3.8 GB");
  });
});
