/**
 * `@makoai/app-sdk` — a REAL package committed into every workspace repo at
 * `packages/app-sdk`, consumed by apps as a `file:` dependency.
 *
 * v1 injected this module at runtime: the host resolved the import from an
 * import map and bridged every call over postMessage. A v2 app is a real
 * Vite project on a real filesystem, so the SDK has to be a real package —
 * resolvable by `vite dev`, by `npm run build`, and by a laptop clone with
 * no Mako host anywhere in sight. Data comes from the same place the
 * runtime serves it: `__data/<name>.parquet`, read in the browser by
 * DuckDB-WASM.
 *
 * The SOURCE is the workspace package at `packages/app-sdk` in this monorepo
 * (plain ESM + .d.ts, no build step, publishable to npm). This module vendors
 * those exact files into workspace repos: the API build copies them to
 * `dist/app-sdk`, so the same relative lookup works under `tsx src/index.ts`
 * and `node dist/index.js` (the pattern system skills use).
 */
import fs from "node:fs";
import path from "node:path";

export const APP_SDK_DIR = "packages/app-sdk";

/** The dependency entry an app needs to import the SDK. */
export const APP_SDK_DEPENDENCY: Record<string, string> = {
  "@makoai/app-sdk": "file:../../packages/app-sdk",
};

/** Files of the package that ship into workspace repos (the npm `files`). */
const SHIPPED_FILES = [
  "package.json",
  "index.js",
  "index.d.ts",
  "vite.js",
  "vite.d.ts",
  "credentials.js",
  "credentials.d.ts",
  "README.md",
] as const;

function candidateDirs(): string[] {
  return [
    // Source tree: api/src/apps → packages/app-sdk
    path.resolve(__dirname, "../../../packages/app-sdk"),
    // Built tree: api/dist/apps → api/dist/app-sdk (copied by `pnpm api:build`)
    path.resolve(__dirname, "../app-sdk"),
    path.resolve(process.cwd(), "packages/app-sdk"),
    path.resolve(process.cwd(), "dist/app-sdk"),
    path.resolve(process.cwd(), "api/dist/app-sdk"),
  ];
}

let resolvedDir: string | null = null;

/** Where the package's files live in this deployment. */
export function appSdkSourceDir(): string {
  if (resolvedDir) return resolvedDir;
  for (const dir of candidateDirs()) {
    if (fs.existsSync(path.join(dir, "index.js"))) {
      resolvedDir = dir;
      return dir;
    }
  }
  throw new Error(
    `@makoai/app-sdk package files not found (looked in ${candidateDirs().join(", ")})`,
  );
}

let cached: Record<string, string> | null = null;

/** Every file of the packaged SDK, ready for a commit. */
export function appSdkFiles(): Record<string, string> {
  if (cached) return cached;
  const dir = appSdkSourceDir();
  const out: Record<string, string> = {};
  for (const name of SHIPPED_FILES) {
    out[`${APP_SDK_DIR}/${name}`] = fs.readFileSync(
      path.join(dir, name),
      "utf8",
    );
  }
  cached = out;
  return out;
}

/** The package version, for logs and the template stamp. */
export function appSdkVersion(): string {
  const pkg = JSON.parse(appSdkFiles()[`${APP_SDK_DIR}/package.json`]) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}
