import { describe, it, expect } from "vitest";
import { basename, dirname } from "./path";

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("models/staging/orders.sql")).toBe("orders.sql");
    expect(basename("orders.sql")).toBe("orders.sql");
  });

  it("ignores a trailing slash", () => {
    expect(basename("models/staging/")).toBe("staging");
  });

  it("falls back to the input when there is no segment", () => {
    expect(basename("")).toBe("");
    expect(basename("/")).toBe("/");
  });
});

describe("dirname", () => {
  it("returns everything before the last segment", () => {
    expect(dirname("models/staging/orders.sql")).toBe("models/staging");
    expect(dirname("models/orders.sql")).toBe("models");
  });

  it("is empty at the top level", () => {
    expect(dirname("orders.sql")).toBe("");
    expect(dirname("")).toBe("");
  });

  it("ignores a trailing slash", () => {
    expect(dirname("models/staging/")).toBe("models");
  });
});
