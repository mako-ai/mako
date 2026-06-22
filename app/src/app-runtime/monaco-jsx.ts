import type { Monaco } from "@monaco-editor/react";

/**
 * Configure Monaco's TS/JS language services so `.tsx` files parse as JSX.
 *
 * We don't load type definitions for react / npm deps into Monaco (apps can
 * install any package, and there is no node_modules), so semantic
 * (type/module-resolution) validation is disabled to avoid false "cannot find
 * module" / "no JSX.IntrinsicElements" errors. Syntax errors are still
 * reported. Real type checking happens at preview-build time via Babel; full
 * IntelliSense is a future WebContainer-runtime concern.
 */
export function configureMonacoForJsx(monaco: Monaco) {
  const ts = monaco.languages.typescript;
  const compilerOptions = {
    jsx: ts.JsxEmit.React,
    jsxFactory: "React.createElement",
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  const diagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: false,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
}

export function languageForPath(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx") || path.endsWith(".js") || path.endsWith(".mjs")) {
    return "javascript";
  }
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}
