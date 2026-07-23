/**
 * Install / update ACP adapter (+ companion CLI) packages via `npm i -g`.
 *
 * Desktop/Chat call this so users don't have to run npm by hand. Results are
 * cached under ~/.mako/agent so we don't reinstall on every Chat turn.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentHomeDir } from "../connection-store";
import { acpLog } from "./log";
import { ensureNpmGlobalPath, pathWithNpmGlobals } from "./path-env";
import {
  ACP_PROVIDERS,
  type AcpProviderId,
} from "./providers";
import { resolveAdapterCommand, resolveOnPath } from "./resolve-command";

/** Skip reinstall when a successful ensure ran within this window (unless force). */
export const ACP_ENSURE_STALE_MS = 12 * 60 * 60 * 1000;

export interface AcpEnsureAdapterResult {
  ok: boolean;
  providerId: AcpProviderId;
  skipped: boolean;
  updated: boolean;
  packages: string[];
  message: string;
  adapterCommand: string | null;
  adapterVia: "env" | "path" | "npx" | null;
  stdoutTail?: string;
  stderrTail?: string;
}

interface EnsureStateFile {
  providers: Partial<
    Record<
      AcpProviderId,
      {
        lastSuccessAt: string;
        packages: string[];
      }
    >
  >;
}

function statePath(): string {
  return join(agentHomeDir(), "acp-ensure.json");
}

function readState(): EnsureStateFile {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as EnsureStateFile;
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    return { providers: parsed.providers || {} };
  } catch {
    return { providers: {} };
  }
}

function writeState(state: EnsureStateFile): void {
  mkdirSync(agentHomeDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
}

/** npm packages to keep current for each ACP provider. */
export function packagesForProvider(providerId: AcpProviderId): string[] {
  const def = ACP_PROVIDERS[providerId];
  if (providerId === "codex") {
    return ["@openai/codex", def.npxPackage];
  }
  return [def.npxPackage];
}

export function shouldSkipEnsure(opts: {
  force?: boolean;
  lastSuccessAt?: string | null;
  adapterVia: "env" | "path" | "npx" | null;
  now?: number;
  staleMs?: number;
}): boolean {
  if (opts.force) return false;
  // Prefer a global install — if we're still on npx, don't skip.
  if (opts.adapterVia === "npx" || opts.adapterVia === null) return false;
  // Env override (tests / custom) — don't fight it.
  if (opts.adapterVia === "env") return true;
  const at = opts.lastSuccessAt ? Date.parse(opts.lastSuccessAt) : NaN;
  if (!Number.isFinite(at)) return false;
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? ACP_ENSURE_STALE_MS;
  return now - at < staleMs;
}

export type NpmInstallRunner = (packages: string[]) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

export async function defaultNpmInstallGlobal(
  packages: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  ensureNpmGlobalPath();
  const npm = resolveOnPath(process.platform === "win32" ? "npm.cmd" : "npm");
  if (!npm) {
    throw new Error(
      "npm not found on PATH. Install Node.js, then retry from Mako Chat.",
    );
  }
  const args = ["install", "-g", "--no-fund", "--no-audit", ...packages];
  return new Promise(resolve => {
    const child = spawn(npm, args, {
      env: {
        ...process.env,
        PATH: pathWithNpmGlobals(process.env.PATH || ""),
        // Avoid interactive npm prompts in Desktop.
        npm_config_yes: "true",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\nnpm install timed out after 3 minutes`,
      });
    }, 3 * 60 * 1000);
    child.on("error", err => {
      clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
      });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function launchSummary(): {
  adapterCommand: string | null;
  adapterVia: "env" | "path" | "npx" | null;
} {
  // Re-resolve after install (PATH may have new globals).
  ensureNpmGlobalPath();
  // Clear any stale "not found" by re-checking — resolveAdapterCommand is pure.
  return { adapterCommand: null, adapterVia: null };
}

export async function ensureAdapterPackages(
  providerId: AcpProviderId,
  options?: {
    force?: boolean;
    runInstall?: NpmInstallRunner;
    /** Injected clock for tests. */
    now?: number;
  },
): Promise<AcpEnsureAdapterResult> {
  const def = ACP_PROVIDERS[providerId];
  const packages = packagesForProvider(providerId);
  ensureNpmGlobalPath();
  const before = resolveAdapterCommand(def);
  const state = readState();
  const prior = state.providers[providerId];

  if (
    shouldSkipEnsure({
      force: options?.force,
      lastSuccessAt: prior?.lastSuccessAt,
      adapterVia: before?.via ?? null,
      now: options?.now,
    })
  ) {
    return {
      ok: true,
      providerId,
      skipped: true,
      updated: false,
      packages,
      message: `${def.label} tools look up to date.`,
      adapterCommand: before
        ? [before.command, ...before.args].join(" ")
        : null,
      adapterVia: before?.via ?? null,
    };
  }

  const runInstall = options?.runInstall ?? defaultNpmInstallGlobal;
  acpLog.info("Ensuring ACP adapter packages", {
    providerId,
    packages,
    force: Boolean(options?.force),
    priorVia: before?.via ?? null,
  });

  let installResult: { code: number | null; stdout: string; stderr: string };
  try {
    installResult = await runInstall(packages);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "npm install failed";
    return {
      ok: false,
      providerId,
      skipped: false,
      updated: false,
      packages,
      message,
      adapterCommand: before
        ? [before.command, ...before.args].join(" ")
        : null,
      adapterVia: before?.via ?? null,
    };
  }

  // Refresh PATH resolution after global install.
  ensureNpmGlobalPath();
  void launchSummary();
  const after = resolveAdapterCommand(def);
  const ok = installResult.code === 0 && Boolean(after);
  if (ok) {
    state.providers[providerId] = {
      lastSuccessAt: new Date(options?.now ?? Date.now()).toISOString(),
      packages,
    };
    writeState(state);
  }

  const stdoutTail = installResult.stdout.trim().slice(-800) || undefined;
  const stderrTail = installResult.stderr.trim().slice(-800) || undefined;
  const message = ok
    ? `Updated ${packages.join(", ")} for ${def.label}.`
    : `Failed to update ${def.label} packages (${packages.join(", ")}).` +
      (stderrTail ? `\n${stderrTail}` : "");

  acpLog.info("ACP adapter ensure finished", {
    providerId,
    ok,
    code: installResult.code,
    via: after?.via ?? null,
  });

  return {
    ok,
    providerId,
    skipped: false,
    updated: ok,
    packages,
    message,
    adapterCommand: after ? [after.command, ...after.args].join(" ") : null,
    adapterVia: after?.via ?? null,
    stdoutTail,
    stderrTail,
  };
}

/** Test helper: clear ensure cache file when present. */
export function clearEnsureStateForTests(): void {
  const path = statePath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify({ providers: {} }, null, 2), "utf8");
  }
}
