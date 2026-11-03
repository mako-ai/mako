/**
 * Apps project scaffold — a normal Vite + React + TypeScript project.
 *
 * Unlike v1 (virtual files + CDN import maps), a v2 app owns its toolchain:
 * real package.json, real scripts, real build. The `mako.json` manifest holds
 * non-secret Mako-specific configuration (entry, data bindings, jobs).
 */
import { appSdkDependency } from "./app-sdk-package";
import { PNPM_VERSION } from "./package-manager";

export interface ScaffoldOptions {
  title: string;
  description?: string;
  /**
   * The app's identity, written into `mako.json` so the app keeps its
   * deployments, sharing and favourites when it is filed into a folder.
   */
  id?: string;
}

export function createAppsScaffold(
  options: ScaffoldOptions,
): Record<string, string> {
  const { title, description, id } = options;
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
        // pnpm: one shared store hard-linked into every app instead of a
        // full node_modules copy per app. Mako installs with whatever this
        // field (or the committed lockfile) names — see package-manager.ts.
        packageManager: `pnpm@${PNPM_VERSION}`,
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
          // From npm, not a `file:` path: a relative path breaks the moment
          // the app is filed into a folder (apps/sales/<app> is one level
          // deeper), and a published package is what a laptop clone wants.
          ...appSdkDependency(),
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
        ...(id ? { id } : {}),
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
import { existsSync, readdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { makoData } from "@makoai/app-sdk/vite";

const bindingsDir = new URL("./bindings", import.meta.url);

export default defineConfig({
  // makoData serves this app's data bindings (__data/*.parquet) during a
  // LOCAL \`vite dev\`, straight from the Mako API — see AGENTS.md → Data.
  // Inside Mako's own sandbox the launcher answers those paths itself and
  // the plugin stays idle.
  plugins: [react(), makoData()],
  // The binding names, for RefreshAllButton (@makoai/app-sdk/ui): a new
  // bindings/<name>.sql is picked up without touching the code.
  define: {
    __APP_BINDING_NAMES__: JSON.stringify(
      existsSync(bindingsDir)
        ? readdirSync(bindingsDir)
            .filter(name => name.endsWith(".sql"))
            .map(name => name.slice(0, -4))
        : [],
    ),
  },
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
    "src/vite-env.d.ts": `/// <reference types="vite/client" />

/** bindings/*.sql names, defined in vite.config.ts. */
declare const __APP_BINDING_NAMES__: string[];
`,
    "src/main.tsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// The house style first, the app's own rules after it so they win.
import "@makoai/app-sdk/ui.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    "src/App.tsx": `import {
  Card,
  KpiRow,
  KpiTile,
  PageHeader,
  RefreshAllButton,
} from "@makoai/app-sdk/ui";

// Mako's house dashboard kit — see node_modules/@makoai/app-sdk/README.md.
export default function App() {
  return (
    <main className="page">
      <PageHeader
        title="${safeTitle.replace(/[<>&"{}]/g, "")}"
        subtitle="Built with Mako Apps — edit src/App.tsx to get started."
        actions={<RefreshAllButton bindings={__APP_BINDING_NAMES__} />}
      />
      <KpiRow>
        <KpiTile label="Your first KPI" value="—" hint="Add a binding, then useQuery()" />
      </KpiRow>
      <Card
        title="Getting started"
        description="Data comes from bindings/<name>.sql; read it with useQuery('<name>')."
      >
        <p className="muted">
          The theme tokens (--background, --brand, --chart-1…) and the kit
          come from @makoai/app-sdk: style with the tokens, reuse the kit.
        </p>
      </Card>
    </main>
  );
}
`,
    "src/styles.css": `/* The theme tokens (--background, --card, --brand, --canvas, --chart-1…5,
   light and dark) are injected by @makoai/app-sdk, and the house base and kit
   styles come from @makoai/app-sdk/ui.css (imported before this file).
   Override a token here to re-theme; keep app layout below. */

.page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}

.muted {
  margin: 0;
  color: var(--muted-foreground);
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
git repository. Run \`pnpm install\` and \`pnpm dev\` locally (this app uses pnpm — do
not run \`npm install\`, it would write a competing \`package-lock.json\`),
or edit it from Mako chat.

The card picture on the Apps home (and the link preview of a public share)
is \`thumbnail.png\` (or \`.svg\`, \`.webp\`,
\`.jpg\`) at the app's root, 1200×750. The one here is a placeholder — replace
it with a showcase of what the app does.
`,
    "thumbnail.svg": defaultThumbnailSvg(safeTitle),
  };
}

const MAKO_MARK =
  "m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z";

const escapeXml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    c =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] as string,
  );

/** Title on two lines at most, by words, for a 1200px-wide card. */
function titleLines(title: string, perLine = 26): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 2) {
    lines[1] = `${lines[1].slice(0, perLine - 1)}…`;
    lines.length = 2;
  }
  return lines.map(l =>
    l.length > perLine ? `${l.slice(0, perLine - 1)}…` : l,
  );
}

/**
 * The starter thumbnail: the app's title on a colour derived from it, with
 * the Mako mark — so a new app's card is recognisable before its builder
 * replaces it with a real showcase. 1200×750 (16:10), plain SVG, no fonts
 * or images to fetch.
 */
export function defaultThumbnailSvg(title: string): string {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const lines = titleLines(title);
  const firstY = lines.length === 1 ? 420 : 380;
  const text = lines
    .map(
      (l, i) =>
        `  <text x="96" y="${firstY + i * 96}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="80" font-weight="700" fill="#fff">${escapeXml(l)}</text>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750" viewBox="0 0 1200 750">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 55% 42%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 24%)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="750" fill="url(#bg)"/>
  <path d="${MAKO_MARK}" fill="#fff" fill-opacity="0.08" transform="translate(720 300) scale(5)"/>
  <path d="${MAKO_MARK}" fill="#fff" transform="translate(96 96) scale(0.8)"/>
${text}
  <text x="96" y="660" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="28" fill="#fff" fill-opacity="0.7">Built with Mako</text>
</svg>
`;
}
