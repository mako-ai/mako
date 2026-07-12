import {
  ALL_TRAFFIC,
  CommandExitError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
  type CommandResult,
  type EntryInfo,
  type SandboxInfo,
} from "e2b";
import {
  isAppV2SessionFileEligible,
  normalizeSandboxFilePath,
} from "../session-files";
import {
  APP_V2_MAX_FILE_BYTES,
  APP_V2_MAX_FILES,
  APP_V2_MAX_TOTAL_BYTES,
} from "../config";
import { AppV2LimitError, AppV2ValidationError } from "../errors";
import type {
  AppV2NetworkPhase,
  SandboxCapture,
  SandboxCreateSpec,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxFile,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "./sandbox-provider";

const WORKSPACE_ROOT = "/workspace";
const INSTALL_EGRESS = ["registry.npmjs.org"];
const MAX_CAPTURE_PATHS = APP_V2_MAX_FILES * 4;
const CLEAN_PATH = "/usr/local/bin:/usr/bin:/bin";
const CONFORMANCE_SCRIPT = String.raw`set -eu
test "$(id -u)" -ne 0
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then exit 71; fi
if env | cut -d= -f1 | grep -Eiq '(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AWS_|AZURE_|GOOGLE_|GCP_|DATABASE_URL|E2B_API_KEY)'; then exit 72; fi
test "$(awk '/^CapEff:/{print $2}' /proc/self/status)" = "0000000000000000"
python3 - <<'PY'
import socket
for host in ("169.254.169.254", "100.100.100.200"):
    sock = socket.socket()
    sock.settimeout(0.25)
    try:
        sock.connect((host, 80))
    except OSError:
        pass
    else:
        raise SystemExit(73)
    finally:
        sock.close()
PY`;

interface E2BCommandHandle {
  readonly pid: number;
  wait(): Promise<CommandResult>;
  kill(): Promise<boolean>;
}

interface E2BSandboxPaginator {
  readonly hasNext: boolean;
  nextItems(options?: {
    apiKey: string;
    signal?: AbortSignal;
  }): Promise<SandboxInfo[]>;
}

export interface E2BSandboxClient {
  readonly sandboxId: string;
  files: {
    exists(
      path: string,
      options?: { signal?: AbortSignal; user?: string },
    ): Promise<boolean>;
    remove(
      path: string,
      options?: { signal?: AbortSignal; user?: string },
    ): Promise<void>;
    makeDir(
      path: string,
      options?: { signal?: AbortSignal; user?: string },
    ): Promise<boolean>;
    write(
      files: Array<{ path: string; data: ArrayBuffer }>,
      options?: { signal?: AbortSignal; user?: string },
    ): Promise<unknown>;
    list(
      path: string,
      options?: { depth?: number; signal?: AbortSignal; user?: string },
    ): Promise<EntryInfo[]>;
    read(
      path: string,
      options: { format: "bytes"; signal?: AbortSignal; user?: string },
    ): Promise<Uint8Array>;
  };
  commands: {
    run(
      command: string,
      options: {
        background: true;
        cwd?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
        user?: string;
        envs?: Record<string, string>;
        onStdout?: (data: string) => void | Promise<void>;
        onStderr?: (data: string) => void | Promise<void>;
      },
    ): Promise<E2BCommandHandle>;
  };
  updateNetwork(
    network: {
      allowOut: string[];
      denyOut: string[];
      allowInternetAccess: boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface E2BSandboxFactory {
  create(
    templateId: string,
    options: {
      apiKey: string;
      signal?: AbortSignal;
      secure: true;
      allowInternetAccess: false;
      timeoutMs: number;
      envs: Record<string, string>;
      metadata: Record<string, string>;
      network: {
        allowOut: string[];
        denyOut: string[];
        allowPublicTraffic: false;
      };
      lifecycle: {
        onTimeout: { action: "pause"; keepMemory: false };
        autoResume: false;
      };
    },
  ): Promise<E2BSandboxClient>;
  connect(
    sandboxId: string,
    options: { apiKey: string; signal?: AbortSignal },
  ): Promise<E2BSandboxClient>;
  getInfo(
    sandboxId: string,
    options: { apiKey: string; signal?: AbortSignal },
  ): Promise<SandboxInfo>;
  pause(
    sandboxId: string,
    options: { apiKey: string; keepMemory: false; signal?: AbortSignal },
  ): Promise<boolean>;
  kill(
    sandboxId: string,
    options: { apiKey: string; signal?: AbortSignal },
  ): Promise<boolean>;
  list(options: {
    apiKey: string;
    query: { metadata: Record<string, string> };
    limit: number;
  }): E2BSandboxPaginator;
}

const defaultFactory: E2BSandboxFactory = {
  create: (templateId, options) => Sandbox.create(templateId, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
  list: options => Sandbox.list(options),
};

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function e2bCommandForArgv(
  argv: readonly string[],
  user: string,
): string {
  if (argv.length === 0) throw new Error("Command argv may not be empty");
  const home = `/home/${user}`;
  return [
    "exec env -i",
    `HOME=${quoteShellArgument(home)}`,
    `PATH=${quoteShellArgument(CLEAN_PATH)}`,
    `BASH_ENV=${quoteShellArgument("/dev/null")}`,
    "setsid --wait --",
    argv.map(quoteShellArgument).join(" "),
  ].join(" ");
}

function boundedAppend(
  current: string,
  chunk: string,
  remainingBytes: number,
): { value: string; consumed: number; truncated: boolean } {
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.byteLength <= remainingBytes) {
    return {
      value: current + chunk,
      consumed: bytes.byteLength,
      truncated: false,
    };
  }
  return {
    value: current + bytes.subarray(0, Math.max(remainingBytes, 0)).toString(),
    consumed: Math.max(remainingBytes, 0),
    truncated: true,
  };
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  constructor(
    private readonly apiKey: string,
    private readonly templateId: string,
    private readonly user: string,
    private readonly factory: E2BSandboxFactory = defaultFactory,
    private readonly idleTimeoutMs = 10 * 60 * 1_000,
  ) {}

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    const sandbox = await this.factory.create(this.templateId, {
      apiKey: this.apiKey,
      signal: spec.signal,
      secure: true,
      allowInternetAccess: false,
      timeoutMs: this.idleTimeoutMs,
      envs: {},
      metadata: {
        ...spec.labels,
        workspaceId: spec.workspaceId,
        projectId: spec.projectId,
        worktreeId: spec.worktreeId,
        actorId: spec.actorId,
        purpose: spec.purpose,
        leaseEpoch: String(spec.leaseEpoch),
        wipOid: spec.durableRevision.wipOid,
      },
      network: {
        allowOut: [],
        denyOut: [ALL_TRAFFIC],
        allowPublicTraffic: false,
      },
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: false },
        autoResume: false,
      },
    });
    try {
      await spec.onProvisioned(sandbox.sandboxId);
      const handle = await sandbox.commands.run(
        `exec setsid --wait -- /bin/sh -c ${quoteShellArgument(CONFORMANCE_SCRIPT)}`,
        {
          background: true,
          timeoutMs: 10_000,
          signal: spec.signal,
          user: this.user,
          envs: {
            HOME: `/home/${this.user}`,
            PATH: CLEAN_PATH,
            BASH_ENV: "/dev/null",
          },
        },
      );
      await handle.wait();
    } catch (error) {
      await this.factory
        .kill(sandbox.sandboxId, { apiKey: this.apiKey })
        .catch(() => undefined);
      throw new AppV2ValidationError(
        `E2B template failed Apps v2 conformance: ${
          error instanceof Error ? error.message : "unknown failure"
        }`,
      );
    }
    return { sandboxId: sandbox.sandboxId, status: "running" };
  }

  async listByLabels(
    labels: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<SandboxHandle[]> {
    const paginator = this.factory.list({
      apiKey: this.apiKey,
      query: { metadata: { ...labels } },
      limit: 100,
    });
    const matches: SandboxHandle[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems({
        apiKey: this.apiKey,
        signal,
      });
      matches.push(
        ...page.map(info => ({
          sandboxId: info.sandboxId,
          status: info.state,
        })),
      );
    }
    return matches;
  }

  async materializeFiles(
    sandboxId: string,
    files: readonly SandboxFile[],
    signal?: AbortSignal,
  ): Promise<void> {
    const sandbox = await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal,
    });
    const fileOptions = { signal, user: this.user };
    if (await sandbox.files.exists(WORKSPACE_ROOT, fileOptions)) {
      await sandbox.files.remove(WORKSPACE_ROOT, fileOptions);
    }
    await sandbox.files.makeDir(WORKSPACE_ROOT, fileOptions);
    if (files.length > 0) {
      await sandbox.files.write(
        files.map(file => {
          const copy = Uint8Array.from(file.content);
          return {
            path: `${WORKSPACE_ROOT}/${file.path}`,
            data: copy.buffer,
          };
        }),
        fileOptions,
      );
    }
    const executablePaths = files
      .filter(file => file.executable)
      .map(file => `${WORKSPACE_ROOT}/${file.path}`);
    if (executablePaths.length > 0) {
      const handle = await sandbox.commands.run(
        e2bCommandForArgv(["chmod", "755", ...executablePaths], this.user),
        {
          background: true,
          timeoutMs: 30_000,
          signal,
          user: this.user,
          envs: this.cleanEnvironment(),
        },
      );
      await handle.wait();
    }
  }

  async captureFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<SandboxCapture> {
    const sandbox = await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal,
    });
    const entries = await this.completeCaptureManifest(sandbox, signal);
    const files: SandboxFile[] = [];
    const excludedPaths: string[] = [];
    let capturedBytes = 0;
    for (const entry of entries) {
      if (entry.type !== FileType.FILE) continue;
      const filePath = normalizeSandboxFilePath(entry.path);
      if (!isAppV2SessionFileEligible(filePath)) {
        excludedPaths.push(filePath);
        continue;
      }
      if (
        entry.size > APP_V2_MAX_FILE_BYTES ||
        files.length >= APP_V2_MAX_FILES ||
        capturedBytes + entry.size > APP_V2_MAX_TOTAL_BYTES
      ) {
        throw new AppV2LimitError("Sandbox source capture exceeds limits");
      }
      const fileType = entry.mode & 0o170000;
      if (fileType !== 0 && fileType !== 0o100000) {
        throw new AppV2ValidationError(
          "Sandbox source contains an unsupported file type",
        );
      }
      const content = await sandbox.files.read(entry.path, {
        format: "bytes",
        signal,
        user: this.user,
      });
      if (
        content.byteLength > APP_V2_MAX_FILE_BYTES ||
        capturedBytes + content.byteLength > APP_V2_MAX_TOTAL_BYTES
      ) {
        throw new AppV2LimitError("Sandbox source capture exceeds limits");
      }
      capturedBytes += content.byteLength;
      files.push({
        path: filePath,
        content,
        executable: (entry.mode & 0o111) !== 0,
      });
    }
    return {
      files,
      excludedPaths: [...new Set(excludedPaths)].sort(),
    };
  }

  private async completeCaptureManifest(
    sandbox: E2BSandboxClient,
    signal?: AbortSignal,
  ): Promise<EntryInfo[]> {
    const options = { signal, user: this.user };
    const recursive = await sandbox.files.list(WORKSPACE_ROOT, {
      ...options,
      depth: 100,
    });
    const recursiveManifest = this.captureManifest(recursive);
    const traversed: EntryInfo[] = [];
    const traversedManifest = new Map<string, string>();
    const queue: Array<{ absolute: string; relative: string }> = [
      { absolute: WORKSPACE_ROOT, relative: "" },
    ];
    while (queue.length > 0) {
      const directory = queue.shift();
      if (!directory) break;
      const direct = await sandbox.files.list(directory.absolute, {
        ...options,
        depth: 1,
      });
      for (const entry of direct) {
        const relative = normalizeSandboxFilePath(entry.path);
        const parent = relative.includes("/")
          ? relative.slice(0, relative.lastIndexOf("/"))
          : "";
        if (parent !== directory.relative) {
          throw new AppV2ValidationError(
            "Sandbox file listing returned an unexpected traversal",
          );
        }
        if (traversedManifest.has(relative)) {
          throw new AppV2ValidationError(
            "Sandbox file listing returned duplicate paths",
          );
        }
        const signature = this.captureEntrySignature(entry);
        traversedManifest.set(relative, signature);
        traversed.push(entry);
        if (traversed.length > MAX_CAPTURE_PATHS) {
          throw new AppV2LimitError("Sandbox source manifest exceeds limits");
        }
        if (entry.type === FileType.DIR) {
          queue.push({
            absolute: `${WORKSPACE_ROOT}/${relative}`,
            relative,
          });
        }
      }
    }
    if (
      recursiveManifest.size !== traversedManifest.size ||
      [...traversedManifest].some(
        ([entryPath, signature]) =>
          recursiveManifest.get(entryPath) !== signature,
      )
    ) {
      throw new AppV2ValidationError(
        "Sandbox file listing was incomplete or inconsistent",
      );
    }
    return traversed;
  }

  private captureManifest(entries: readonly EntryInfo[]): Map<string, string> {
    const manifest = new Map<string, string>();
    for (const entry of entries) {
      const filePath = normalizeSandboxFilePath(entry.path);
      if (manifest.has(filePath)) {
        throw new AppV2ValidationError(
          "Sandbox file listing returned duplicate paths",
        );
      }
      manifest.set(filePath, this.captureEntrySignature(entry));
      if (manifest.size > MAX_CAPTURE_PATHS) {
        throw new AppV2LimitError("Sandbox source manifest exceeds limits");
      }
    }
    return manifest;
  }

  private captureEntrySignature(entry: EntryInfo): string {
    if (entry.symlinkTarget !== undefined) {
      throw new AppV2ValidationError("Sandbox source contains a symlink");
    }
    if (entry.type !== FileType.FILE && entry.type !== FileType.DIR) {
      throw new AppV2ValidationError(
        "Sandbox source contains an unsupported file type",
      );
    }
    const fileType = entry.mode & 0o170000;
    const expectedType = entry.type === FileType.FILE ? 0o100000 : 0o040000;
    if (fileType !== 0 && fileType !== expectedType) {
      throw new AppV2ValidationError(
        "Sandbox source contains an unsupported file type",
      );
    }
    return JSON.stringify({
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      symlinkTarget: entry.symlinkTarget,
    });
  }

  async exec(
    sandboxId: string,
    spec: SandboxExecSpec,
  ): Promise<SandboxExecResult> {
    const sandbox = await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal: spec.signal,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let handle: E2BCommandHandle | undefined;
    let killRequested = false;
    const capture = async (stream: "stdout" | "stderr", chunk: string) => {
      const appended = boundedAppend(
        stream === "stdout" ? stdout : stderr,
        chunk,
        spec.maxOutputBytes - outputBytes,
      );
      outputBytes += appended.consumed;
      outputTruncated ||= appended.truncated;
      if (stream === "stdout") stdout = appended.value;
      else stderr = appended.value;
      if (appended.truncated) {
        killRequested = true;
        if (handle) await this.terminateProcessGroup(sandbox, handle);
      }
    };

    let cancelled = spec.signal?.aborted ?? false;
    const cancel = () => {
      cancelled = true;
      if (handle) void this.terminateProcessGroup(sandbox, handle);
    };
    spec.signal?.addEventListener("abort", cancel, { once: true });
    try {
      handle = await sandbox.commands.run(
        e2bCommandForArgv(spec.argv, this.user),
        {
          background: true,
          cwd: spec.cwd,
          timeoutMs: spec.timeoutMs,
          signal: spec.signal,
          user: this.user,
          envs: this.cleanEnvironment(),
          onStdout: data => capture("stdout", data),
          onStderr: data => capture("stderr", data),
        },
      );
      if (killRequested || cancelled) {
        await this.terminateProcessGroup(sandbox, handle);
      }
      const result = await handle.wait();
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        timedOut: false,
        cancelled,
        outputTruncated,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout,
          stderr,
          timedOut: false,
          cancelled,
          outputTruncated,
        };
      }
      if (error instanceof TimeoutError) {
        if (handle) await this.terminateProcessGroup(sandbox, handle);
        return {
          exitCode: null,
          stdout,
          stderr,
          timedOut: !cancelled,
          cancelled,
          outputTruncated,
        };
      }
      if (cancelled) {
        if (handle) await this.terminateProcessGroup(sandbox, handle);
        return {
          exitCode: null,
          stdout,
          stderr,
          timedOut: false,
          cancelled: true,
          outputTruncated,
        };
      }
      throw error;
    } finally {
      spec.signal?.removeEventListener("abort", cancel);
    }
  }

  private cleanEnvironment(): Record<string, string> {
    return {
      HOME: `/home/${this.user}`,
      PATH: CLEAN_PATH,
      BASH_ENV: "/dev/null",
    };
  }

  private async terminateProcessGroup(
    sandbox: E2BSandboxClient,
    handle: E2BCommandHandle,
  ): Promise<void> {
    await handle.kill().catch(() => false);
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) return;
    try {
      const cleanup = await sandbox.commands.run(
        e2bCommandForArgv(["kill", "-KILL", "--", `-${handle.pid}`], this.user),
        {
          background: true,
          timeoutMs: 5_000,
          user: this.user,
          envs: this.cleanEnvironment(),
        },
      );
      await cleanup.wait();
    } catch {
      // The process group normally disappears when the command exits.
    }
  }

  async setNetworkPhase(
    sandboxId: string,
    phase: AppV2NetworkPhase,
    signal?: AbortSignal,
  ): Promise<void> {
    const sandbox = await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal,
    });
    await sandbox.updateNetwork(
      {
        allowOut: phase === "install" ? INSTALL_EGRESS : [],
        denyOut: [ALL_TRAFFIC],
        allowInternetAccess: false,
      },
      { signal },
    );
  }

  async pause(sandboxId: string, signal?: AbortSignal): Promise<void> {
    await this.factory.pause(sandboxId, {
      apiKey: this.apiKey,
      keepMemory: false,
      signal,
    });
  }

  async quiesce(sandboxId: string, signal?: AbortSignal): Promise<void> {
    await this.factory.pause(sandboxId, {
      apiKey: this.apiKey,
      keepMemory: false,
      signal,
    });
    await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal,
    });
  }

  async kill(sandboxId: string, signal?: AbortSignal): Promise<void> {
    await this.factory.kill(sandboxId, { apiKey: this.apiKey, signal });
  }

  async status(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<SandboxStatus> {
    try {
      const info = await this.factory.getInfo(sandboxId, {
        apiKey: this.apiKey,
        signal,
      });
      return info.state;
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return "missing";
      }
      throw error;
    }
  }
}
