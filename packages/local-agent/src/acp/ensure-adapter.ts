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

export type AcpEnsureErrorCode =
  | "npm_missing"
  | "eacces"
  | "timeout"
  | "npm_failed"
  | "adapter_missing";

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
  errorCode?: AcpEnsureErrorCode;
}

export function classifyEnsureFailure(args: {
  message: string;
  code: number | null;
  stderr?: string;
  adapterFound: boolean;
}): AcpEnsureErrorCode {
  const text = `${args.message}\n${args.stderr || ""}`;
  if (/npm not found/i.test(text)) return "npm_missing";
  if (/EACCES|permission denied|EPERM/i.test(text)) return "eacces";
  if (args.code === null || /timed out/i.test(text)) return "timeout";
  if (!args.adapterFound && args.code === 0) return "adapter_missing";
  return "npm_failed";
}

export function ensureErrorUserMessage(code: AcpEnsureErrorCode): string {
  switch (code) {
    case "npm_missing":
      return "Node.js/npm is not on PATH. Install Node, restart Mako Desktop, then retry.";
    case "eacces":
      return "npm lacks permission to install globally. Fix npm permissions or run Install again after configuring a user npm prefix.";
    case "timeout":
      return "Installing Codex/Claude tools timed out. Check your network and retry Update adapter.";
    case "adapter_missing":
      return "Packages installed but the adapter binary is still missing from PATH. Restart Local Agent and retry.";
    default:
      return "Failed to install/update local coding-agent tools. See details and retry Update adapter.";
  }
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
  // Not npm-distributed (Cursor CLI installs via curl) — nothing to ensure.
  if (!def.npxPackage) return [];
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
  // Global PATH install already present (brew/npm/manual). Never block Chat on
  // a first-time `npm i -g` just because we have no ensure timestamp yet —
  // that hang is what users see as "Installing/updating Codex tools…".
  const at = opts.lastSuccessAt ? Date.parse(opts.lastSuccessAt) : NaN;
  if (!Number.isFinite(at)) return true;
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

  // Nothing npm can install (Cursor CLI): report presence, never run npm.
  if (packages.length === 0) {
    const found = Boolean(before);
    return {
      ok: found,
      providerId,
      skipped: true,
      updated: false,
      packages,
      message: found
        ? `${def.label} CLI found — Mako keeps it as installed (${def.label} updates itself).`
        : `${def.label} CLI is not installed. ${def.installHint}`,
      adapterCommand: before
        ? [before.command, ...before.args].join(" ")
        : null,
      adapterVia: before?.via ?? null,
      errorCode: found ? undefined : "adapter_missing",
    };
  }

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
    const errorCode = classifyEnsureFailure({
      message,
      code: 1,
      adapterFound: Boolean(before),
    });
    return {
      ok: false,
      providerId,
      skipped: false,
      updated: false,
      packages,
      message: `${ensureErrorUserMessage(errorCode)}\n${message}`,
      adapterCommand: before
        ? [before.command, ...before.args].join(" ")
        : null,
      adapterVia: before?.via ?? null,
      errorCode,
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
  const errorCode = ok
    ? undefined
    : classifyEnsureFailure({
        message: stderrTail || "",
        code: installResult.code,
        stderr: stderrTail,
        adapterFound: Boolean(after),
      });
  const message = ok
    ? `Updated ${packages.join(", ")} for ${def.label}.`
    : `${ensureErrorUserMessage(errorCode || "npm_failed")}\n` +
      `Failed to update ${def.label} packages (${packages.join(", ")}).` +
      (stderrTail ? `\n${stderrTail}` : "");

  acpLog.info("ACP adapter ensure finished", {
    providerId,
    ok,
    code: installResult.code,
    via: after?.via ?? null,
    errorCode: errorCode ?? null,
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
    errorCode,
  };
}

/** Test helper: clear ensure cache file when present. */
export function clearEnsureStateForTests(): void {
  const path = statePath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify({ providers: {} }, null, 2), "utf8");
  }
}
