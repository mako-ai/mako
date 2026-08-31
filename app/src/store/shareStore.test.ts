// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TAB_DEEP_LINK_PATTERNS } from "../lib/tab-routing";
import {
  buildWorkspaceResourceUrl,
  type ShareResourceType,
} from "./shareStore";

/** Deep-link pattern that must hydrate each shareable resource's URL. */
const TAB_PATTERN_FOR_RESOURCE: Record<ShareResourceType, RegExp> = {
  dashboard: TAB_DEEP_LINK_PATTERNS.dashboard,
  console: TAB_DEEP_LINK_PATTERNS.console,
  app: TAB_DEEP_LINK_PATTERNS.app,
};

describe("buildWorkspaceResourceUrl", () => {
  it("builds an absolute URL from the current origin", () => {
    expect(buildWorkspaceResourceUrl("dashboard", "dash-123")).toBe(
      `${window.location.origin}/d/dash-123`,
    );
  });

  // The copied link is only useful if UrlSync can hydrate it back into a
  // tab, so each resource's path must match its tab-routing deep-link
  // pattern. Guards against the two modules drifting apart.
  it.each(Object.keys(TAB_PATTERN_FOR_RESOURCE) as ShareResourceType[])(
    "produces a hydratable deep link for %s",
    resourceType => {
      const url = new URL(buildWorkspaceResourceUrl(resourceType, "abc-123"));
      const match = url.pathname.match(TAB_PATTERN_FOR_RESOURCE[resourceType]);
      expect(match?.[1]).toBe("abc-123");
    },
  );
});
