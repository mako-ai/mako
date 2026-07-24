/**
 * GUI apps (Electron Desktop) often start with a stripped PATH that omits
 * Homebrew / npm global bins. Without these, we fall back to `npx` every
 * launch — which hits ~/.npm/_npx and frequently fails with ENOTEMPTY.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Extra dirs to prepend when looking for npm-global CLIs. */
export function npmGlobalBinDirs(): string[] {
  const home = homedir();
  const dirs = [
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const npmPrefix = process.env.npm_config_prefix?.trim();
  if (npmPrefix) {
    dirs.unshift(join(npmPrefix, "bin"));
  }

  // nvm / fnm / volta when already exported into the agent process env
  const nvmDir = process.env.NVM_DIR?.trim();
  if (nvmDir && process.version) {
    dirs.unshift(join(nvmDir, "versions", "node", process.version, "bin"));
  }
  const fnmMultishell = process.env.FNM_MULTISHELL_PATH?.trim();
  if (fnmMultishell) {
    dirs.unshift(fnmMultishell);
  }
  const voltaHome = process.env.VOLTA_HOME?.trim();
  if (voltaHome) {
    dirs.unshift(join(voltaHome, "bin"));
  }

  return dirs;
}

/** Return PATH with common npm-global bins prepended (deduped). */
export function pathWithNpmGlobals(pathEnv = process.env.PATH || ""): string {
  const existing = pathEnv.split(delimiter).filter(Boolean);
  const seen = new Set(existing);
  const prepend: string[] = [];
  for (const dir of npmGlobalBinDirs()) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    prepend.push(dir);
  }
  return [...prepend, ...existing].join(delimiter);
}

/** Mutate process.env.PATH so child spawns and resolveOnPath see npm globals. */
export function ensureNpmGlobalPath(): void {
  process.env.PATH = pathWithNpmGlobals(process.env.PATH || "");
}
