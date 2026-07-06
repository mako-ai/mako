import { describe, expect, it } from "vitest";
import {
  appLocationFromHostSearch,
  appLocationToHostSearch,
  formatAppLocation,
  parseAppLocation,
  resolveAppLocation,
} from "./app-location";

describe("app-location", () => {
  it("parses relative URLs into pathname + search (dropping hash)", () => {
    expect(parseAppLocation("/customers/1?tab=open#frag")).toEqual({
      pathname: "/customers/1",
      search: "?tab=open",
    });
    expect(parseAppLocation("")).toEqual({ pathname: "/", search: "" });
    expect(parseAppLocation(undefined)).toEqual({ pathname: "/", search: "" });
  });

  it("round-trips an app location through the host query string", () => {
    const cases = [
      "/",
      "/?tab=customers",
      "/customers/123",
      "/customers/123?sort=asc&dir=up",
      // Comma is re-encoded as %2C on the way out but decodes to the same
      // value, so compare parsed semantics rather than the raw string.
      "/?c=ES,FR&s=vis&q=fuentes",
    ];
    const norm = (rel: string) => {
      const { pathname, search } = parseAppLocation(rel);
      const params = [...new URLSearchParams(search)].sort();
      return { pathname, params };
    };
    for (const rel of cases) {
      const host = appLocationToHostSearch(rel);
      expect(norm(appLocationFromHostSearch(host))).toEqual(norm(rel));
    }
  });

  it("keeps app query params readable and stows the path in _path", () => {
    expect(appLocationToHostSearch("/customers/123?tab=open&c=ES")).toBe(
      "?tab=open&c=ES&_path=%2Fcustomers%2F123",
    );
    // Root path emits no _path param at all.
    expect(appLocationToHostSearch("/?tab=open")).toBe("?tab=open");
    expect(appLocationToHostSearch("/")).toBe("");
  });

  it("decodes a host query string back into an app location", () => {
    expect(
      appLocationFromHostSearch("?tab=open&c=ES&_path=%2Fcustomers%2F123"),
    ).toBe("/customers/123?tab=open&c=ES");
    expect(appLocationFromHostSearch("")).toBe("/");
    expect(appLocationFromHostSearch("?tab=open")).toBe("/?tab=open");
  });

  it("resolves absolute, relative and query-only navigation targets", () => {
    expect(resolveAppLocation("/customers", "/orders")).toBe("/orders");
    expect(resolveAppLocation("/customers/1", "?tab=open")).toBe(
      "/customers/1?tab=open",
    );
    expect(resolveAppLocation("/customers/1", "../orders")).toBe("/orders");
    expect(resolveAppLocation("/a/b", "c")).toBe("/a/c");
  });

  it("formats locations with a guaranteed leading slash", () => {
    expect(formatAppLocation({ pathname: "x/y", search: "?q=1" })).toBe(
      "/x/y?q=1",
    );
  });
});
