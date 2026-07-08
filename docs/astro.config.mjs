// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

// https://astro.build/config
export default defineConfig({
  site: "https://docs.mako.ai",
  integrations: [
    starlight({
      title: "Mako Docs",
      // Editorial theme matching the mako.ai marketing site.
      customCss: ["./src/styles/editorial.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/mako-ai/mako",
        },
      ],
      plugins: [
        // Renders interactive REST API reference pages from the OpenAPI spec
        // generated from the Hono route table (`pnpm --filter api openapi:generate`).
        starlightOpenAPI([
          {
            base: "api",
            label: "REST API",
            schema: "./src/openapi/mako-api.json",
          },
        ]),
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Welcome", slug: "index" },
            { label: "Introduction", slug: "intro" },
            { label: "Getting Started", slug: "getting-started" },
          ],
        },
        {
          label: "Core Features",
          items: [
            { label: "AI-Powered SQL Client", slug: "ai-agent" },
            { label: "Console", slug: "console" },
            { label: "Dashboards", slug: "dashboards" },
            { label: "Version History", slug: "version-history" },
            { label: "Apps", slug: "apps" },
            { label: "Transforms (dbt)", slug: "transforms" },
            { label: "Query Runner", slug: "query-runner" },
            { label: "Self-Directive", slug: "self-directive" },
            { label: "Skills", slug: "skills" },
            { label: "MCP Connectors", slug: "mcp-connectors" },
            { label: "Notifications", slug: "notifications" },
            { label: "Mako Desktop", slug: "desktop" },
          ],
        },
        {
          label: "Databases",
          items: [
            { label: "Connect Databases", slug: "databases/connect-databases" },
          ],
        },
        {
          label: "Guides",
          items: [{ label: "Authentication", slug: "guides/authentication" }],
        },
        {
          label: "Operations",
          items: [
            { label: "Architecture", slug: "architecture" },
            { label: "Deployment", slug: "deployment" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "API Overview", slug: "api-reference" }],
        },
        // Auto-generated REST API reference (from the OpenAPI spec).
        ...openAPISidebarGroups,
        {
          label: "Roadmap",
          items: [{ label: "Roadmap", slug: "roadmap" }],
        },
        {
          label: "Experimental",
          collapsed: true,
          items: [
            { label: "SaaS Sync (Connectors)", slug: "connectors" },
            { label: "Data Sync & Flows", slug: "data-sync" },
            {
              label: "Building Connectors",
              slug: "guides/building-connectors",
            },
          ],
        },
      ],
    }),
  ],
});
