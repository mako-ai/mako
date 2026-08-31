/**
 * Apps project scaffold — a normal Vite + React + TypeScript project.
 *
 * Unlike v1 (virtual files + CDN import maps), a v2 app owns its toolchain:
 * real package.json, real scripts, real build. The `mako.json` manifest holds
 * non-secret Mako-specific configuration (entry, data bindings, jobs).
 */

export interface ScaffoldOptions {
  title: string;
  description?: string;
}

export function createAppsScaffold(
  options: ScaffoldOptions,
): Record<string, string> {
  const { title, description } = options;
  const safeTitle = title.trim() || "Mako App";
  const pkgName =
    safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "mako-app";

  return {
    "package.json": `${JSON.stringify(
      {
        name: pkgName,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          dev: "vite",
          // Publish builds with vite (esbuild) only — the same transform dev
          // uses. Type-checking is a SEPARATE `typecheck` script, not a
          // publish gate: a migrated v1 app renders fine but is rarely
          // tsc-clean, and blocking publish on `tsc -b` made every such app
          // unpublishable with no way to opt out.
          build: "vite build",
          typecheck: "tsc -b",
          preview: "vite preview",
        },
        dependencies: {
          "@makoai/app-sdk": "file:../../packages/app-sdk",
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
        devDependencies: {
          "@types/react": "^18.2.66",
          "@types/react-dom": "^18.2.22",
          "@vitejs/plugin-react": "^4.2.1",
          typescript: "^5.4.0",
          vite: "^5.2.0",
        },
      },
      null,
      2,
    )}\n`,
    "mako.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        title: safeTitle,
        ...(description ? { description } : {}),
        entry: "src/main.tsx",
        bindings: [],
      },
      null,
      2,
    )}\n`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle.replace(/[<>&]/g, "")}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { makoData } from "@makoai/app-sdk/vite";

export default defineConfig({
  // makoData serves this app's data bindings (__data/*.parquet) during a
  // LOCAL \`vite dev\`, straight from the Mako API — see AGENTS.md → Data.
  // Inside Mako's own sandbox the launcher answers those paths itself and
  // the plugin stays idle.
  plugins: [react(), makoData()],
  // Relative asset URLs so builds work under any hosting prefix
  // (including Mako's token-scoped preview paths).
  base: "./",
  server: {
    // The preview reaches the dev server on the sandbox's public origin
    // (<port>-<sandbox>.e2b.app). Without this, a \`vite\` started from the
    // terminal answers "Blocked request. This host is not allowed."
    host: true,
    allowedHosts: [".e2b.app"],
  },
});
`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          useDefineForClassFields: true,
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          skipLibCheck: true,
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
          strict: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    "src/main.tsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    "src/App.tsx": `export default function App() {
  return (
    <main className="container">
      <h1>${safeTitle.replace(/[<>&]/g, "")}</h1>
      <p>Built with Mako Apps — edit src/App.tsx to get started.</p>
    </main>
  );
}
`,
    "src/styles.css": `/* Mako theme tokens — same contract the SDK injects (explicit here so the
   scaffold works without the SDK, and apps can see what to override). */
:root {
  color-scheme: light;
  --background: hsl(0 0% 100%);
  --foreground: hsl(240 10% 3.9%);
  --card: hsl(0 0% 100%);
  --card-foreground: hsl(240 10% 3.9%);
  --popover: hsl(0 0% 100%);
  --popover-foreground: hsl(240 10% 3.9%);
  --primary: hsl(240 5.9% 10%);
  --primary-foreground: hsl(0 0% 98%);
  --secondary: hsl(240 4.8% 95.9%);
  --secondary-foreground: hsl(240 5.9% 10%);
  --muted: hsl(240 4.8% 95.9%);
  --muted-foreground: hsl(240 3.8% 46.1%);
  --accent: hsl(240 4.8% 95.9%);
  --accent-foreground: hsl(240 5.9% 10%);
  --destructive: hsl(0 84.2% 60.2%);
  --destructive-foreground: hsl(0 0% 98%);
  --border: hsl(240 5.9% 90%);
  --input: hsl(240 5.9% 90%);
  --ring: hsl(240 5.9% 10%);
  --chart-1: hsl(12 76% 61%);
  --chart-2: hsl(173 58% 39%);
  --chart-3: hsl(197 37% 24%);
  --chart-4: hsl(43 74% 66%);
  --chart-5: hsl(27 87% 67%);
  --radius: 0.5rem;
}
:root.dark {
  color-scheme: dark;
  --background: hsl(240 10% 3.9%);
  --foreground: hsl(0 0% 98%);
  --card: hsl(240 10% 3.9%);
  --card-foreground: hsl(0 0% 98%);
  --popover: hsl(240 10% 3.9%);
  --popover-foreground: hsl(0 0% 98%);
  --primary: hsl(0 0% 98%);
  --primary-foreground: hsl(240 5.9% 10%);
  --secondary: hsl(240 3.7% 15.9%);
  --secondary-foreground: hsl(0 0% 98%);
  --muted: hsl(240 3.7% 15.9%);
  --muted-foreground: hsl(240 5% 64.9%);
  --accent: hsl(240 3.7% 15.9%);
  --accent-foreground: hsl(0 0% 98%);
  --destructive: hsl(0 62.8% 30.6%);
  --destructive-foreground: hsl(0 0% 98%);
  --border: hsl(240 3.7% 15.9%);
  --input: hsl(240 3.7% 15.9%);
  --ring: hsl(240 4.9% 83.9%);
  --chart-1: hsl(220 70% 50%);
  --chart-2: hsl(160 60% 45%);
  --chart-3: hsl(30 80% 55%);
  --chart-4: hsl(280 65% 60%);
  --chart-5: hsl(340 75% 55%);
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    color-scheme: dark;
    --background: hsl(240 10% 3.9%);
    --foreground: hsl(0 0% 98%);
    --card: hsl(240 10% 3.9%);
    --card-foreground: hsl(0 0% 98%);
    --popover: hsl(240 10% 3.9%);
    --popover-foreground: hsl(0 0% 98%);
    --primary: hsl(0 0% 98%);
    --primary-foreground: hsl(240 5.9% 10%);
    --secondary: hsl(240 3.7% 15.9%);
    --secondary-foreground: hsl(0 0% 98%);
    --muted: hsl(240 3.7% 15.9%);
    --muted-foreground: hsl(240 5% 64.9%);
    --accent: hsl(240 3.7% 15.9%);
    --accent-foreground: hsl(0 0% 98%);
    --destructive: hsl(0 62.8% 30.6%);
    --destructive-foreground: hsl(0 0% 98%);
    --border: hsl(240 3.7% 15.9%);
    --input: hsl(240 3.7% 15.9%);
    --ring: hsl(240 4.9% 83.9%);
    --chart-1: hsl(220 70% 50%);
    --chart-2: hsl(160 60% 45%);
    --chart-3: hsl(30 80% 55%);
    --chart-4: hsl(280 65% 60%);
    --chart-5: hsl(340 75% 55%);
  }
}
body { background: var(--background); color: var(--foreground); }

:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
}

.container {
  max-width: 720px;
  margin: 4rem auto;
  padding: 0 1rem;
}
`,
    ".gitignore": `node_modules
dist
*.local
.env
# Tool state that must never enter durable snapshots
.npm
.cache
.config
.local
.pnpm-store
.vite
tsconfig.tsbuildinfo
`,
    "README.md": `# ${safeTitle}

${description ?? "A Mako app."}

Built with Mako Apps: a real Vite + React project stored in a Mako-managed
git repository. Run \`npm install\` (or pnpm/yarn) and \`npm run dev\` locally,
or edit it from Mako chat.
`,
  };
}
