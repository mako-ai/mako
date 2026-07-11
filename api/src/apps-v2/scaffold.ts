/**
 * Apps v2 project scaffold — a normal Vite + React + TypeScript project.
 *
 * Unlike v1 (virtual files + CDN import maps), a v2 app owns its toolchain:
 * real package.json, real scripts, real build. The `mako.json` manifest holds
 * non-secret Mako-specific configuration (entry, data bindings, jobs).
 */

export interface ScaffoldOptions {
  title: string;
  description?: string;
}

export function createAppsV2Scaffold(
  options: ScaffoldOptions,
): Record<string, string> {
  const { title, description } = options;
  const safeTitle = title.trim() || "Mako App";
  const pkgName = safeTitle
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
          build: "tsc -b && vite build",
          preview: "vite preview",
        },
        dependencies: {
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

export default defineConfig({
  plugins: [react()],
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
      <p>Built with Mako Apps v2 — edit src/App.tsx to get started.</p>
    </main>
  );
}
`,
    "src/styles.css": `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  color: #213547;
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

Built with Mako Apps v2: a real Vite + React project stored in a Mako-managed
git repository. Run \`npm install\` (or pnpm/yarn) and \`npm run dev\` locally,
or edit it from Mako chat.
`,
  };
}
