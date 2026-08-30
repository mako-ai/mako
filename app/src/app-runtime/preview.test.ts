import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildPreviewHtml } from "./preview";
import type { AppEntity } from "./app-entity";

const app = {
  _id: "app1",
  title: "Test app",
  entrypoint: "src/App.tsx",
  dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
  files: [
    {
      path: "src/App.tsx",
      contents: "export default function App() { return null; }",
    },
  ],
} as unknown as AppEntity;

function extractModuleScript(html: string): string {
  const script = html.split('<script type="module">')[1]?.split("</script>")[0];
  expect(script).toBeTruthy();
  return String(script);
}

describe("buildPreviewHtml", () => {
  it("embeds a syntactically valid bootstrap script", () => {
    // BOOTSTRAP_SOURCE is a String.raw template embedded verbatim into the
    // srcdoc — a stray backtick or ${ inside it corrupts the literal and
    // breaks every app preview. Parsing the generated script catches that.
    const script = extractModuleScript(buildPreviewHtml(app));
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it("injects the rowLimit/truncated plumbing into the SDK hooks", () => {
    const script = extractModuleScript(buildPreviewHtml(app));
    expect(script).toContain("useQuery(name, opts)");
    expect(script).toContain("useDuckDB(sql, opts)");
    // The hooks must forward the requested cap to the parent bridge…
    expect(script).toContain("rowLimit: rowLimit");
    // …and warn when the parent reports dropped rows.
    expect(script).toContain("warnTruncated");
  });

  it("injects light/dark theme tokens and pre-wires the body colors", () => {
    const html = buildPreviewHtml(app);
    // Resolved color values (var(--background) usable directly), both modes.
    expect(html).toContain("--background: hsl(0 0% 100%)");
    expect(html).toContain(":root.dark");
    expect(html).toContain("--background: hsl(240 10% 3.9%)");
    expect(html).toContain("--chart-5");
    // Zero-code default: apps inherit themed body background/text.
    expect(html).toContain("background: var(--background)");
    expect(html).toContain("color: var(--foreground)");
  });

  it("embeds the host theme in the payload (null = follow system)", () => {
    const payloadOf = (html: string) =>
      JSON.parse(
        String(
          html
            .split('<script id="mako-payload" type="application/json">')[1]
            ?.split("</script>")[0],
        ),
      ) as { theme: string | null };
    expect(payloadOf(buildPreviewHtml(app, { theme: "dark" })).theme).toBe(
      "dark",
    );
    expect(payloadOf(buildPreviewHtml(app, { theme: "light" })).theme).toBe(
      "light",
    );
    expect(payloadOf(buildPreviewHtml(app)).theme).toBeNull();
  });

  it("wires live theme switching and the useTheme SDK hook in the bootstrap", () => {
    const script = extractModuleScript(buildPreviewHtml(app));
    // Parent-driven toggles (embedded in Mako)…
    expect(script).toContain("mako-app:set-theme");
    // …system fallback when standalone…
    expect(script).toContain("prefers-color-scheme: dark");
    // …applied before the app renders, and exposed to app code.
    expect(script).toContain("setExplicitTheme(payload.theme)");
    expect(script).toContain("useTheme()");
  });
});
