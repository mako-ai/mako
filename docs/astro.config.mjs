// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://docs.mako.ai",
  integrations: [
    starlight({
      title: "Mako Docs",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/mako-ai/mono",
        },
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
            { label: "Query Runner", slug: "query-runner" },
            { label: "Self-Directive", slug: "self-directive" },
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
          items: [{ label: "API Reference", slug: "api-reference" }],
        },
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
