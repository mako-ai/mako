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
    server: {
      port: 5173,
      allowedHosts: true,
      proxy: {
        "/api": {
          target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8080",
          changeOrigin: true,
        },
      },
    },
  };
});
