import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import reactScan from "@react-scan/vite-plugin-react-scan";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    reactScan({
      enable: process.env.VITE_REACT_SCAN === "true",
      autoDisplayNames: true,
    }),
    tailwindcss(),
  ],
  envDir: "..",
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        configure: proxy => {
          proxy.on("proxyReq", (proxyReq, req) => {
            const host =
              (req.headers["x-forwarded-host"] as string) || req.headers.host;
            if (host) proxyReq.setHeader("x-forwarded-host", host);
            const proto =
              (req.headers["x-forwarded-proto"] as string) || "http";
            proxyReq.setHeader("x-forwarded-proto", proto);
          });
        },
      },
    },
  },
});
