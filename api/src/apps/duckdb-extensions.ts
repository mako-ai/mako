/**
 * DuckDB extensions baked into the API image.
 *
 * Chat-with-app's direct-GCS mode needs `httpfs`. Installing it at runtime
 * would download from extensions.duckdb.org on every new Cloud Run instance,
 * so the Dockerfile runs this module's CLI once at build time with the same
 * `@duckdb/node-api` binary the server uses (exact DuckDB version and
 * platform), into `DUCKDB_EXTENSION_DIRECTORY`. At runtime the server only
 * LOADs from that directory, with auto-install off, and fails loudly when the
 * file is missing.
 *
 * Kept dependency-free (no logger, no config) so the CLI runs in the slim
 * runtime stage: `node dist/apps/duckdb-extensions.js <dir>`.
 *
 * Local dev: `pnpm --filter api exec tsx src/apps/duckdb-extensions.ts`
 * installs into DuckDB's default `~/.duckdb/extensions`.
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export const DUCKDB_EXTENSION_DIR_ENV = "DUCKDB_EXTENSION_DIRECTORY";

/** Extensions the API image bakes. */
export const BAKED_EXTENSIONS = ["httpfs"] as const;
export type BakedExtension = (typeof BAKED_EXTENSIONS)[number];

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The configured extension directory, or null for DuckDB's default. */
export function duckdbExtensionDirectory(): string | null {
  const dir = process.env[DUCKDB_EXTENSION_DIR_ENV]?.trim();
  return dir ? dir : null;
}

/**
 * LOAD a baked extension. Never downloads: auto-install and auto-load are
 * switched off first, and there is no INSTALL. A missing file throws an error
 * that names the directory and the fix.
 */
export async function loadBakedExtension(
  connection: DuckDBConnection,
  name: BakedExtension,
  dir: string | null = duckdbExtensionDirectory(),
): Promise<void> {
  await connection.run("SET autoinstall_known_extensions = false");
  await connection.run("SET autoload_known_extensions = false");
  if (dir) {
    await connection.run(`SET extension_directory = ${literal(dir)}`);
  }
  try {
    await connection.run(`LOAD ${name}`);
  } catch (error) {
    const where = dir ?? "DuckDB's default ~/.duckdb/extensions";
    throw new Error(
      `DuckDB extension "${name}" is not installed in ${where}. ` +
        `The API image bakes it at build time (Dockerfile → node dist/apps/duckdb-extensions.js); ` +
        `locally run \`pnpm --filter api exec tsx src/apps/duckdb-extensions.ts\`. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * INSTALL every baked extension into `dir` (or DuckDB's default) and LOAD it
 * back to prove the file matches this binary. Network access happens here
 * only — at image build time, in dev, or in a test setup.
 */
export async function bakeExtensions(
  dir: string | null = duckdbExtensionDirectory(),
): Promise<{ version: string; platform: string; dir: string | null }> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    if (dir) {
      await connection.run(`SET extension_directory = ${literal(dir)}`);
    }
    for (const name of BAKED_EXTENSIONS) {
      await connection.run(`INSTALL ${name}`);
      await connection.run(`LOAD ${name}`);
    }
    const info = await connection.runAndReadAll(
      "SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform",
    );
    const [row] = info.getRowObjectsJson() as Array<{
      version: string;
      platform: string;
    }>;
    return { version: row.version, platform: row.platform, dir };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

// CLI: `node dist/apps/duckdb-extensions.js [dir]`. `require` is undefined
// when vitest/tsx load this file as ESM, hence the typeof guard.
if (typeof require !== "undefined" && require.main === module) {
  const dir = process.argv[2] ?? duckdbExtensionDirectory();
  bakeExtensions(dir)
    .then(result => {
      process.stdout.write(
        `Baked DuckDB ${BAKED_EXTENSIONS.join(", ")} for ${result.version} ${result.platform} into ${result.dir ?? "~/.duckdb/extensions"}\n`,
      );
    })
    .catch(error => {
      process.stderr.write(
        `Failed to bake DuckDB extensions: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
