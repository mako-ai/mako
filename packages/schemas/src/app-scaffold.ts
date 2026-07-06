/**
 * Default scaffold for a new React App.
 *
 * Mirrors the "Blank App" template used by builders like dyad: a small
 * React + TypeScript starter. The `@mako/app-sdk` data binding hook is shown
 * in a comment (not live code) so a fresh app renders without errors — the
 * scaffold ships with no data bindings.
 */

import type { AppDefinition, AppFile } from "./app.schema";

const APP_TSX = `// Read workspace data with the injected SDK once a data binding exists:
//
//   import { useQuery } from "@mako/app-sdk";
//   const { data, loading, error } = useQuery("my_binding");
//
// Create bindings from the chat ("bind the revenue query") or the data panel.
//
// Keep view state (tabs, filters, selected record) in the URL so reloads
// restore it and links are shareable — use the SDK, not window.history:
//
//   import { useSearchParams, navigate } from "@mako/app-sdk";
//   const [params, setParams] = useSearchParams();
//
// Persist values users EDIT in the app (targets, notes, overrides) with the
// storage hook — server-side, shared by everyone who uses the app:
//
//   import { useStorage } from "@mako/app-sdk";
//   const { value, setValue, saving, readOnly } = useStorage("my-key", {});
//
// Theming: the runtime provides CSS variables (--background, --foreground,
// --card, --border, --muted-foreground, --primary, --chart-1..5, --radius, …)
// that switch with light/dark automatically — use var(--token) instead of
// hardcoded colors. The page background/text are already wired up.

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Hello from your Mako app</h1>
      <div
        style={{
          background: "var(--card)",
          color: "var(--card-foreground)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 16,
          maxWidth: 480,
        }}
      >
        <p style={{ margin: 0 }}>
          Edit <code>src/App.tsx</code> and ask the assistant to build features.
        </p>
        <p style={{ margin: "8px 0 0", color: "var(--muted-foreground)" }}>
          This card follows the light/dark theme on its own.
        </p>
      </div>
    </div>
  );
}
`;

const README_MD = `# Mako App

A React app running inside Mako with access to your workspace databases.

## Data bindings

Read workspace data with the injected SDK:

\`\`\`tsx
import { useQuery } from "@mako/app-sdk";

const { data, loading, error } = useQuery("my_binding");
\`\`\`

Queries execute server-side, scoped to your workspace — the app never sees
database credentials.

## Theming (light/dark)

The app inherits its theme automatically: Mako's theme when opened inside the
workspace, the OS preference when opened from a share link. The runtime injects
ready-to-use CSS variables that switch between modes:

\`--background\`, \`--foreground\`, \`--card\`, \`--card-foreground\`,
\`--popover\`, \`--popover-foreground\`, \`--primary\`, \`--primary-foreground\`,
\`--secondary\`, \`--secondary-foreground\`, \`--muted\`, \`--muted-foreground\`,
\`--accent\`, \`--accent-foreground\`, \`--destructive\`,
\`--destructive-foreground\`, \`--border\`, \`--input\`, \`--ring\`,
\`--chart-1\`…\`--chart-5\`, \`--radius\`

Use \`var(--token)\` instead of hardcoded colors (works in inline styles,
CSS-in-JS, and SVG/chart \`fill\`/\`stroke\`). The page background and text are
pre-wired. When code needs the literal mode (e.g. a chart library option):

\`\`\`tsx
import { useTheme } from "@mako/app-sdk";

const { theme } = useTheme(); // "light" | "dark"
\`\`\`

## URL state (shareable, reload-safe)

Keep view state — the open tab, active filters, a selected record — in the URL
so reloads restore it and links are shareable. This works both inside Mako
(\`/a/:appId\`) and in the public share view (\`/share/:token\`). Use the SDK
hooks, not \`window.history\`/\`location\` (the app is sandboxed and those won't
persist or share):

\`\`\`tsx
import { useLocation, useSearchParams, navigate } from "@mako/app-sdk";

const loc = useLocation();              // { pathname, search, hash, href, searchParams }
const [params, setParams] = useSearchParams();
const tab = params.get("tab") ?? "overview";

setParams({ tab: "customers" }, { replace: true }); // filters within a view
navigate("/customers/42");                            // distinct view / detail page
\`\`\`

Use \`{ replace: true }\` for high-frequency updates (filter typing) so
back/forward isn't flooded; the default pushes a new history entry.

## Persistent storage (user-editable values)

For values users edit in the app UI — targets, notes, manual overrides — use
the storage hook. Values are stored server-side per app, shared by everyone who
uses the app, and survive reloads and publishes. Public share viewers get
read-only access (\`readOnly: true\`).

\`\`\`tsx
import { useStorage } from "@mako/app-sdk";

const { value, setValue, loading, saving, error, readOnly } =
  useStorage("csm-targets", {} as Record<string, number>);

setValue(prev => ({ ...prev, [repId]: 25 })); // optimistic write-through
\`\`\`
`;

export const DEFAULT_APP_SCAFFOLD_FILES: AppFile[] = [
  { path: "src/App.tsx", contents: APP_TSX },
  { path: "README.md", contents: README_MD },
];

export const DEFAULT_APP_SCAFFOLD: Omit<AppDefinition, "title"> = {
  description: undefined,
  template: "react-ts",
  runtime: "cdn",
  entrypoint: "src/App.tsx",
  files: DEFAULT_APP_SCAFFOLD_FILES,
  dependencies: {
    react: "^18.2.0",
    "react-dom": "^18.2.0",
  },
  dataBindings: [],
};

/** Build a full app definition for a new app with the given title. */
export function createAppScaffold(title: string): AppDefinition {
  return {
    title,
    ...DEFAULT_APP_SCAFFOLD,
    // Clone arrays/objects so callers can mutate safely.
    files: DEFAULT_APP_SCAFFOLD_FILES.map(f => ({ ...f })),
    dependencies: { ...DEFAULT_APP_SCAFFOLD.dependencies },
    dataBindings: [],
  };
}
