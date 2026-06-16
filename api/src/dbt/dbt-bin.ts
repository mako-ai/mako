/**
 * dbt binary resolution.
 *
 * Order:
 *   1. DBT_VENV_BIN env (prod — Dockerfile bakes a pinned venv at /opt/dbt)
 *   2. `uvx` dev fallback: runs dbt-core pinned with the adapter package
 *      injected (`uvx --from dbt-core==<v> --with <adapter> dbt ...`)
 *   3. Clear error telling the operator what to install.
 */

import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";

export const DEFAULT_DBT_CORE_VERSION = "1.9.10";

export interface ResolvedDbtBin {
  /** Executable to spawn. */
  bin: string;
  /** Args to prepend before the dbt subcommand argv. */
  prefixArgs: string[];
}

let cachedUvxAvailable: boolean | null = null;

function isUvxAvailable(): boolean {
  if (cachedUvxAvailable !== null) return cachedUvxAvailable;
  try {
    const result = spawnSync("uvx", ["--version"], { timeout: 10_000 });
    cachedUvxAvailable = result.status === 0;
  } catch {
    cachedUvxAvailable = false;
  }
  return cachedUvxAvailable;
}

/**
 * Resolve how to invoke dbt for a given adapter package.
 * @param adapterPackage e.g. "dbt-postgres"
 * @param dbtVersion pinned dbt-core minor/patch, e.g. "1.9" or "1.9.4"
 */
export function resolveDbtBin(
  adapterPackage: string,
  dbtVersion?: string,
): ResolvedDbtBin {
  // dbt-mysql lags upstream (dbt-core ~=1.7) so it lives in its own venv.
  const venvBin =
    adapterPackage === "dbt-mysql"
      ? process.env.DBT_MYSQL_VENV_BIN
      : process.env.DBT_VENV_BIN;
  if (venvBin) {
    if (!existsSync(venvBin)) {
      throw new Error(
        `dbt venv binary "${venvBin}" does not exist (check DBT_VENV_BIN / DBT_MYSQL_VENV_BIN)`,
      );
    }
    return { bin: venvBin, prefixArgs: [] };
  }

  if (isUvxAvailable()) {
    const coreVersion =
      adapterPackage === "dbt-mysql"
        ? "1.7.19"
        : dbtVersion && dbtVersion.split(".").length >= 3
          ? dbtVersion
          : DEFAULT_DBT_CORE_VERSION;
    return {
      bin: "uvx",
      prefixArgs: [
        "--from",
        `dbt-core==${coreVersion}`,
        "--with",
        adapterPackage,
        "dbt",
      ],
    };
  }

  throw new Error(
    "No dbt binary available. Set DBT_VENV_BIN to a dbt executable " +
      "(production image bakes one at /opt/dbt/bin/dbt) or install uv " +
      "(https://docs.astral.sh/uv/) so the runner can use `uvx` locally.",
  );
}

function dbtCoreVersionFor(
  adapterPackage: string,
  dbtVersion?: string,
): string {
  if (adapterPackage === "dbt-mysql") return "1.7.19";
  return dbtVersion && dbtVersion.split(".").length >= 3
    ? dbtVersion
    : DEFAULT_DBT_CORE_VERSION;
}

/**
 * Resolve how to launch the resident dbt engine (a long-lived Python process
 * running `enginePath`), mirroring {@link resolveDbtBin}'s resolution order so
 * the engine uses the SAME dbt-core + adapter as the subprocess path.
 *
 *   1. DBT_ENGINE_PYTHON_CMD — JSON array override (tests / custom infra);
 *      enginePath is appended.
 *   2. The baked venv's python (sibling of DBT_VENV_BIN) in production.
 *   3. `uv run` dev fallback with dbt-core + the adapter injected.
 */
export function resolveDbtEnginePython(
  adapterPackage: string,
  dbtVersion: string | undefined,
  enginePath: string,
): ResolvedDbtBin {
  const override = process.env.DBT_ENGINE_PYTHON_CMD;
  if (override) {
    const parts = JSON.parse(override) as string[];
    return { bin: parts[0], prefixArgs: [...parts.slice(1), enginePath] };
  }

  const venvBin =
    adapterPackage === "dbt-mysql"
      ? process.env.DBT_MYSQL_VENV_BIN
      : process.env.DBT_VENV_BIN;
  if (venvBin) {
    const python = join(dirname(venvBin), "python");
    if (!existsSync(python)) {
      throw new Error(
        `dbt venv python "${python}" does not exist (check DBT_VENV_BIN)`,
      );
    }
    return { bin: python, prefixArgs: [enginePath] };
  }

  if (isUvxAvailable()) {
    const coreVersion = dbtCoreVersionFor(adapterPackage, dbtVersion);
    return {
      bin: "uv",
      prefixArgs: [
        "run",
        "--no-project",
        "--with",
        `dbt-core==${coreVersion}`,
        "--with",
        adapterPackage,
        "python",
        enginePath,
      ],
    };
  }

  throw new Error(
    "No Python available for the dbt engine. Set DBT_VENV_BIN " +
      "(production bakes /opt/dbt/bin/python) or install uv for local dev.",
  );
}
