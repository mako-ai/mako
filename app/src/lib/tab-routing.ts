/**
 * Tab routing — single source of truth for entity URLs.
 *
 * Every kind of tab that can open in the editor gets a unique, shareable
 * URL. This module owns both directions of that mapping:
 *
 *  - `tabUrlPath`: tab -> URL (what UrlSync writes to the address bar)
 *  - `TAB_DEEP_LINK_PATTERNS`: URL -> tab kind (what UrlSync hydration
 *    matches on page load)
 *
 * REGRESSION GUARD: both are exhaustive over `TabKind`. When you add a new
 * tab kind, `tsc` fails here (and in EntityBreadcrumbs.tsx) until you decide
 * how the new kind is addressed — either a real URL + pattern, or an
 * explicit `null` for kinds that cannot be deep-linked. The round-trip unit
 * test in `tab-routing.test.ts` keeps the two directions in sync.
 */
import type { ConsoleTab, TabKind } from "../store/lib/types";
import { appLocationToHostSearch } from "../app-runtime/app-location";

/** Encode a path that may contain slashes, keeping the slashes readable. */
export function encodePathSegments(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Inverse of {@link encodePathSegments}. */
export function decodePathSegments(encoded: string): string {
  return encoded.split("/").filter(Boolean).map(decodeURIComponent).join("/");
}

/**
 * Deep-link URL patterns per tab kind, matched against
 * `window.location.pathname` during hydration (most specific first — see
 * UrlSync). `null` means the kind intentionally has no deep link (legacy
 * kinds only). Being a `Record` over all kinds, adding a `TabKind` without
 * deciding its pattern is a compile error.
 */
export const TAB_DEEP_LINK_PATTERNS = {
  console: /^\/c\/([a-zA-Z0-9-]+)/,
  connectors: /^\/cx\/([a-zA-Z0-9-]+)/,
  "flow-editor": /^\/f\/([a-zA-Z0-9-]+)/,
  dashboard: /^\/d\/([a-zA-Z0-9-]+)\/?$/,
  "dashboard-data-source": /^\/d\/([a-zA-Z0-9-]+)\/data\/([a-zA-Z0-9-]+)/,
  "table-data": /^\/t\/([a-zA-Z0-9-]+)\/([^/]+)\/([^/]+)\/?$/,
  app: /^\/a\/([a-zA-Z0-9-]+)\/?$/,
  "app-file": /^\/a\/([a-zA-Z0-9-]+)\/file\/(.+)$/,
  "app-binding": /^\/a\/([a-zA-Z0-9-]+)\/data\/([a-zA-Z0-9-]+)/,
  plan: /^\/p\/([a-zA-Z0-9-]+)/,
  settings: /^\/settings\/([a-z-]+)$/,
  // Legacy tab kind superseded by the settings "members" section.
  members: null,
  // dbt (Transforms) tabs are addressed under /x/:projectId. The bare project
  // URL is the Console (project home); runs/file/job hang off it.
  "dbt-file": /^\/x\/([a-zA-Z0-9-]+)\/file\/(.+)$/,
  "dbt-job": /^\/x\/([a-zA-Z0-9-]+)\/job\/([a-zA-Z0-9-]+)/,
  "dbt-runs": /^\/x\/([a-zA-Z0-9-]+)\/runs\/?$/,
  "dbt-console": /^\/x\/([a-zA-Z0-9-]+)\/?$/,
} as const satisfies Record<NonNullable<TabKind>, RegExp | null>;

/**
 * The URL (pathname + optional query string) owned by a tab, or `null` when
 * the tab cannot be addressed yet (e.g. a connector that was never saved).
 */
export function tabUrlPath(tabId: string, tab: ConsoleTab): string | null {
  const kind: NonNullable<TabKind> = tab.kind ?? "console";
  switch (kind) {
    case "console":
      return `/c/${tabId}`;
    case "connectors":
      return typeof tab.content === "string" && tab.content
        ? `/cx/${tab.content}`
        : null;
    case "flow-editor":
      return tab.metadata?.flowId ? `/f/${tab.metadata.flowId}` : null;
    case "dashboard":
      return tab.metadata?.dashboardId
        ? `/d/${tab.metadata.dashboardId}`
        : null;
    case "dashboard-data-source": {
      const dashboardId = tab.metadata?.dashboardId as string | undefined;
      const dataSourceId = tab.metadata?.dataSourceId as string | undefined;
      return dashboardId && dataSourceId
        ? `/d/${dashboardId}/data/${dataSourceId}`
        : null;
    }
    case "table-data": {
      const schema = tab.metadata?.schema as string | undefined;
      const table = tab.metadata?.table as string | undefined;
      if (!tab.connectionId || !table) return null;
      const params = new URLSearchParams();
      if (tab.databaseName) params.set("db", tab.databaseName);
      if (tab.databaseId) params.set("dbid", tab.databaseId);
      const query = params.toString();
      return (
        `/t/${tab.connectionId}/${encodeURIComponent(schema || "public")}` +
        `/${encodeURIComponent(table)}${query ? `?${query}` : ""}`
      );
    }
    case "app": {
      const appId = tab.metadata?.appId as string | undefined;
      if (!appId) return null;
      // The running app projects its own location (path + query) onto the
      // host URL: query params stay readable, the app pathname rides in the
      // reserved `_path` param. The bare `/a/:appId` pathname is unchanged, so
      // the deep-link pattern still matches.
      const appLocation = tab.metadata?.appLocation as string | undefined;
      return `/a/${appId}${appLocationToHostSearch(appLocation)}`;
    }
    case "app-file": {
      const appId = tab.metadata?.appId as string | undefined;
      const path = tab.metadata?.path as string | undefined;
      return appId && path
        ? `/a/${appId}/file/${encodePathSegments(path)}`
        : null;
    }
    case "app-binding": {
      const appId = tab.metadata?.appId as string | undefined;
      const bindingId = tab.metadata?.bindingId as string | undefined;
      return appId && bindingId ? `/a/${appId}/data/${bindingId}` : null;
    }
    case "plan": {
      const chatId = tab.metadata?.chatId as string | undefined;
      return chatId ? `/p/${chatId}` : null;
    }
    case "settings":
      return tab.settingsSection
        ? `/settings/${tab.settingsSection}`
        : "/settings";
    case "members":
      return null;
    case "dbt-file": {
      const projectId = tab.metadata?.projectId as string | undefined;
      const path = tab.metadata?.path as string | undefined;
      return projectId && path
        ? `/x/${projectId}/file/${encodePathSegments(path)}`
        : null;
    }
    case "dbt-job": {
      const projectId = tab.metadata?.projectId as string | undefined;
      const jobId = tab.metadata?.jobId as string | undefined;
      return projectId && jobId ? `/x/${projectId}/job/${jobId}` : null;
    }
    case "dbt-runs": {
      const projectId = tab.metadata?.projectId as string | undefined;
      return projectId ? `/x/${projectId}/runs` : null;
    }
    case "dbt-console": {
      const projectId = tab.metadata?.projectId as string | undefined;
      return projectId ? `/x/${projectId}` : null;
    }
    default: {
      // Compile-time exhaustiveness: a new TabKind must be handled above.
      const exhaustivenessCheck: never = kind;
      void exhaustivenessCheck;
      return null;
    }
  }
}
