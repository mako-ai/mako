// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TAB_DEEP_LINK_PATTERNS } from "../lib/tab-routing";
import {
  buildWorkspaceResourceUrl,
  type ShareResourceType,
} from "./shareStore";

/** Deep-link pattern for resources that open inside the Mako shell. */
const TAB_PATTERN_FOR_RESOURCE: Partial<Record<ShareResourceType, RegExp>> = {
  console: TAB_DEEP_LINK_PATTERNS.console,
};

describe("buildWorkspaceResourceUrl", () => {
  it("builds an absolute URL from the current origin", () => {
    expect(buildWorkspaceResourceUrl("console", "console-123")).toBe(
      `${window.location.origin}/c/console-123`,
    );
  });

  // The copied link is only useful if UrlSync can hydrate it back into a
  // tab, so each resource's path must match its tab-routing deep-link
  // pattern. Guards against the two modules drifting apart.
  it.each(Object.keys(TAB_PATTERN_FOR_RESOURCE) as ShareResourceType[])(
    "produces a hydratable deep link for %s",
    resourceType => {
      const url = new URL(buildWorkspaceResourceUrl(resourceType, "abc-123"));
      const pattern = TAB_PATTERN_FOR_RESOURCE[resourceType];
      expect(pattern).toBeDefined();
      if (!pattern) throw new Error(`Missing pattern for ${resourceType}`);
      const match = url.pathname.match(pattern);
      expect(match?.[1]).toBe("abc-123");
    },
  );

  it("copies the canonical viewer URL for an app, never the raw /live/ route", () => {
    const url = buildWorkspaceResourceUrl("app", "app-123", "workspace-456");
    expect(url).toBe(`${window.location.origin}/view/workspace-456/app-123`);
    expect(url).not.toContain("/live");
  });
});
