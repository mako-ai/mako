/**
 * `@makoai/app-sdk` — the published package apps depend on from npm.
 *
 * It used to be committed into every workspace repo at `packages/app-sdk`
 * (a vendored copy the template overwrote); since template v20 it is not,
 * and the refresh retires the old copy once no app references it.
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
 * (plain ESM + .d.ts, no build step, published to npm by publish-npm.yml).
 * The API only needs its version: the build copies `package.json` to
 * `dist/app-sdk`, so the same lookup works under `tsx src/index.ts` and
 * `node dist/index.js`.
 */
import fs from "node:fs";
import path from "node:path";

/** Where the retired vendored copy lives in older workspace repos. */
export const APP_SDK_DIR = "packages/app-sdk";

/**
 * The dependency entry an app needs to import the SDK: the published package,
 * pinned to the major of the version this API ships with. Not the vendored
 * `file:../../packages/app-sdk` any more — that path is relative to the app's
 * depth, so it broke the first time an app was filed into a folder, and a
 * laptop clone wants a registry package anyway. Deploys move the app to the
 * newest release inside this range (package-manager.ts).
 */
export function appSdkDependency(): Record<string, string> {
  return { "@makoai/app-sdk": `^${appSdkVersion()}` };
}

/**
 * The pre-npm dependency entry, kept ONLY for the applied 2026-08-25
 * migration (migrations are never edited once applied — see
 * `.cursor/rules/90-migrations.mdc`). New scaffolds use appSdkDependency().
 */
export const APP_SDK_DEPENDENCY: Record<string, string> = {
  "@makoai/app-sdk": "file:../../packages/app-sdk",
};

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

let cachedVersion: string | null = null;

/**
 * The package version this API ships with — new apps get a caret range on
 * it. Only `package.json` is read: the package itself reaches apps from npm,
 * never as a copy in the workspace repo.
 */
export function appSdkVersion(): string {
  if (cachedVersion) return cachedVersion;
  for (const dir of candidateDirs()) {
    const file = path.join(dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? "0.0.0";
    return cachedVersion;
  }
  throw new Error(
    `@makoai/app-sdk package.json not found (looked in ${candidateDirs().join(", ")})`,
  );
}

/** Files of the package as the retired vendored copy shipped them. */
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

/**
 * Every file of the old vendored copy, ready for a commit. Kept ONLY for the
 * applied 2026-08-25 migration (migrations are never edited once applied);
 * nothing writes `packages/app-sdk` into a workspace repo any more.
 */
export function appSdkFiles(): Record<string, string> {
  const dir = candidateDirs().find(d =>
    fs.existsSync(path.join(d, "index.js")),
  );
  if (!dir) {
    throw new Error(
      `@makoai/app-sdk package files not found (looked in ${candidateDirs().join(", ")})`,
    );
  }
  const out: Record<string, string> = {};
  for (const name of SHIPPED_FILES) {
    out[`${APP_SDK_DIR}/${name}`] = fs.readFileSync(
      path.join(dir, name),
      "utf8",
    );
  }
  return out;
}
