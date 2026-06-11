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

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Hello from your Mako app</h1>
      <p>Edit <code>src/App.tsx</code> and ask the assistant to build features.</p>
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
