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
