import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import reactScan from "@react-scan/vite-plugin-react-scan";
import tailwindcss from "@tailwindcss/vite";

/**
 * Emits a version.json file into the build output containing the build ID
 * (git SHA in CI). It ships inside the same Docker image as the API, which
 * serves it back via GET /api/version so long-lived clients (especially the
 * desktop app) can detect when their loaded bundle is stale.
 */
function emitVersionJson(buildId: string): Plugin {
  return {
    name: "mako:emit-version-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId }),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // envDir is the repo root (".." relative to app/) — same place Vite loads
  // .env.production from during the Docker build.
  const env = loadEnv(mode, path.resolve(process.cwd(), ".."), "");
  const buildId = env.VITE_BUILD_ID || "dev";

  return {
    plugins: [
      react(),
      reactScan({
        enable: process.env.VITE_REACT_SCAN === "true",
        autoDisplayNames: true,
      }),
      tailwindcss(),
      emitVersionJson(buildId),
    ],
    envDir: "..",
    // Tailwind v4 runs through the @tailwindcss/vite plugin above, so no
    // PostCSS plugins are needed. Pinning an empty config stops Vite's
    // upward search from picking up a stray postcss.config.js in an
    // ancestor directory (e.g. a developer's home dir), which would load a
    // mismatched Tailwind and fail every stylesheet.
    css: { postcss: { plugins: [] } },
    server: {
      port: 5173,
      allowedHosts: true,
      // Opt-in polling watcher. fsevents does not deliver file changes to a
      // Vite launched from certain detached shells (observed: agent-driven
      // background sessions on macOS) — the server runs fine but never sees
      // an edit, and every change needs a full restart. Polling is the
      // reliable fallback there; it stays OFF by default because it costs
      // CPU that a normally-launched dev server does not need to pay.
      ...(process.env.VITE_WATCH_POLL
        ? { watch: { usePolling: true, interval: 400 } }
        : {}),
      proxy: {
        "/api": {
          target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8080",
          changeOrigin: true,
          // The Apps v2 terminal is a WebSocket under /api. Without this the
          // upgrade request is served as plain HTTP and the socket closes
          // immediately — the terminal works in a deployed build and only
          // fails in local development, which is the worst way round.
          ws: true,
        },
        // OAuth discovery documents for the MCP endpoint (RFC 9728/8414):
        // MCP clients fetch these from the same origin as /api/mcp.
        "/.well-known": {
          target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8080",
          changeOrigin: true,
        },
      },
    },
  };
});
