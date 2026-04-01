import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
