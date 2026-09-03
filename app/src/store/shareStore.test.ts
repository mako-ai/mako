// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TAB_DEEP_LINK_PATTERNS } from "../lib/tab-routing";
import {
  buildWorkspaceResourceUrl,
  type ShareResourceType,
} from "./shareStore";

/** Deep-link pattern for resources that open inside the Mako shell. */
const TAB_PATTERN_FOR_RESOURCE: Partial<Record<ShareResourceType, RegExp>> = {
  dashboard: TAB_DEEP_LINK_PATTERNS.dashboard,
  console: TAB_DEEP_LINK_PATTERNS.console,
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
      const pattern = TAB_PATTERN_FOR_RESOURCE[resourceType];
      expect(pattern).toBeDefined();
      if (!pattern) throw new Error(`Missing pattern for ${resourceType}`);
      const match = url.pathname.match(pattern);
      expect(match?.[1]).toBe("abc-123");
    },
  );

  it("builds a fullscreen published-app URL for workspace members", () => {
    expect(buildWorkspaceResourceUrl("app", "app-123", "workspace-456")).toBe(
      `${window.location.origin}/api/workspaces/workspace-456/apps/app-123/live/`,
    );
  });
});
