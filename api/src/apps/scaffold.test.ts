import { describe, expect, it } from "vitest";
import { createAppsScaffold, defaultThumbnailSvg } from "./scaffold";
import { APP_THUMBNAIL_FILES } from "./app-index.service";

describe("starter thumbnail", () => {
  it("ships a thumbnail by the convention the index reads", () => {
    const files = createAppsScaffold({ title: "Leads by canton" });
    const thumb = Object.keys(files).find(f =>
      (APP_THUMBNAIL_FILES as readonly string[]).includes(f),
    );
    expect(thumb).toBe("thumbnail.svg");
    expect(files["thumbnail.svg"]).toContain('viewBox="0 0 1200 750"');
    expect(files["thumbnail.svg"]).toContain("Leads by canton");
  });

  it("escapes the title, wraps it to two lines, and is stable per title", () => {
    const svg = defaultThumbnailSvg(
      `<script>alert(1)</script> & a very long title that keeps going and going`,
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg.match(/font-size="80"/g)).toHaveLength(2);
    expect(defaultThumbnailSvg("Quotas")).toBe(defaultThumbnailSvg("Quotas"));
    expect(defaultThumbnailSvg("Quotas")).not.toBe(
      defaultThumbnailSvg("Leads"),
    );
  });
});

describe("vite.config.ts", () => {
  it("reads bindings/ only when it exists, so a shell app with no data builds", () => {
    const config = createAppsScaffold({ title: "Shell" })["vite.config.ts"];
    expect(config).toContain("existsSync(bindingsDir)");
    // Every readdirSync of bindings/ sits behind the existsSync guard.
    expect(config).not.toMatch(/readdirSync\(new URL\("\.\/bindings"/);
  });
});
