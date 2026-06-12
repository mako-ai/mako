import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildPreviewHtml } from "./preview";
import type { AppEntity } from "../store/appStore";

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
});
