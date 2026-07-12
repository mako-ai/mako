import { randomUUID } from "node:crypto";
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
  getAppsV2MaxRepositoryBytes,
} from "../config";
import { AppV2LimitError, AppV2ValidationError } from "../errors";
import { validateAppV2GitBranch, validateAppV2GitOid } from "./git-provider";
import type {
  AppV2NetworkPhase,
  SandboxCapture,
  SandboxCreateSpec,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxFile,
  SandboxHandle,
  SandboxProvider,
  SandboxRepositoryMaterialization,
  SandboxRepositorySnapshot,
  SandboxStatus,
} from "./sandbox-provider";

const WORKSPACE_ROOT = "/workspace";
const INSTALL_EGRESS = ["registry.npmjs.org"];
const MAX_CAPTURE_PATHS = APP_V2_MAX_FILES * 4;
const CLEAN_PATH = "/usr/local/bin:/usr/bin:/bin";
const CLEAN_ROOT_PATH = `${CLEAN_PATH}:/usr/local/sbin:/usr/sbin:/sbin`;
const BLOCKED_GIT_REMOTE = "https://apps-v2.mako.invalid/blocked.git";
const BUNDLE_PATH_PREFIX = "/tmp/mako-apps-v2-controller-";
const PRESERVED_CACHE_PATHS = [
  "node_modules/",
  "dist/",
  ".cache/",
  ".pnpm-store/",
  ".turbo/",
  ".vite/",
  "coverage/",
] as const;
const RUNTIME_ISOLATION_SCRIPT = String.raw`set -eu
iptables -C OUTPUT -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I OUTPUT -d 169.254.169.254/32 -j REJECT
iptables -C OUTPUT -d 169.254.169.254/32 -j REJECT`;
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
        onTimeout: "pause";
        autoResume: true;
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
    options: { apiKey: string; keepMemory: boolean; signal?: AbortSignal },
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
  const home = user === "root" ? "/root" : `/home/${user}`;
  const commandPath = user === "root" ? CLEAN_ROOT_PATH : CLEAN_PATH;
  return [
    "exec env -i",
    `HOME=${quoteShellArgument(home)}`,
    `PATH=${quoteShellArgument(commandPath)}`,
    `BASH_ENV=${quoteShellArgument("/dev/null")}`,
    `GIT_CONFIG_GLOBAL=${quoteShellArgument("/dev/null")}`,
    `GIT_CONFIG_NOSYSTEM=${quoteShellArgument("1")}`,
    `GIT_TERMINAL_PROMPT=${quoteShellArgument("0")}`,
    `GCM_INTERACTIVE=${quoteShellArgument("never")}`,
    `GIT_ASKPASS=${quoteShellArgument("/bin/false")}`,
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
        onTimeout: "pause",
        autoResume: true,
      },
    });
    try {
      await this.applyRuntimeIsolation(sandbox, spec.signal);
      await this.assertConformance(sandbox, spec.signal);
      await spec.onProvisioned(sandbox.sandboxId);
    } catch (error) {
      await this.factory
        .kill(sandbox.sandboxId, { apiKey: this.apiKey })
        .catch(() => undefined);
      throw new AppV2ValidationError(
        `E2B sandbox failed Apps v2 conformance/runtime isolation: ${
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

  async materializeRepository(
    sandboxId: string,
    snapshot: SandboxRepositorySnapshot,
    materialization: SandboxRepositoryMaterialization,
    signal?: AbortSignal,
  ): Promise<void> {
    const branch = validateAppV2GitBranch(snapshot.branch);
    const branchHead = validateAppV2GitOid(snapshot.branchHead);
    const wipOid = validateAppV2GitOid(snapshot.wipOid);
    if (
      snapshot.bundle.byteLength === 0 ||
      snapshot.bundle.byteLength > getAppsV2MaxRepositoryBytes()
    ) {
      throw new AppV2LimitError("Invalid Apps v2 Git bundle size");
    }
    const sandbox = await this.secureConnect(sandboxId, signal);
    await sandbox.updateNetwork(
      {
        allowOut: [],
        denyOut: [ALL_TRAFFIC],
        allowInternetAccess: false,
      },
      { signal },
    );
    const fileOptions = { signal, user: this.user };
    const bundlePath = `${BUNDLE_PATH_PREFIX}${randomUUID()}.bundle`;
    const bundle = Uint8Array.from(snapshot.bundle);
    let sourceEquivalent = false;
    try {
      await sandbox.files.write(
        [{ path: bundlePath, data: bundle.buffer }],
        fileOptions,
      );
      if (materialization === "fresh") {
        if (await sandbox.files.exists(WORKSPACE_ROOT, fileOptions)) {
          await sandbox.files.remove(WORKSPACE_ROOT, fileOptions);
        }
        await sandbox.files.makeDir(WORKSPACE_ROOT, fileOptions);
        await this.runControllerCommand(
          sandbox,
          [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.file.allow=always",
            "clone",
            "--no-checkout",
            "--no-hardlinks",
            "--origin",
            "origin",
            "--",
            bundlePath,
            WORKSPACE_ROOT,
          ],
          undefined,
          signal,
        );
      } else {
        if (
          !(await sandbox.files.exists(`${WORKSPACE_ROOT}/.git`, fileOptions))
        ) {
          throw new AppV2ValidationError(
            "Cannot update a sandbox without a Git worktree",
          );
        }
        await this.runControllerCommand(
          sandbox,
          [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--force",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            bundlePath,
            "+refs/heads/*:refs/mako/controller/heads/*",
            "+refs/mako/worktrees/*:refs/mako/controller/worktrees/*",
          ],
          WORKSPACE_ROOT,
          signal,
        );
        const [currentBranch, currentIndexTree, incomingWipTree] =
          await Promise.all([
            this.runControllerCommand(
              sandbox,
              ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
              WORKSPACE_ROOT,
              signal,
            ),
            this.runControllerCommand(
              sandbox,
              ["git", "write-tree"],
              WORKSPACE_ROOT,
              signal,
            ),
            this.runControllerCommand(
              sandbox,
              ["git", "rev-parse", "--verify", `${wipOid}^{tree}`],
              WORKSPACE_ROOT,
              signal,
            ),
          ]);
        sourceEquivalent =
          currentBranch.stdout.trim() === branch &&
          currentIndexTree.stdout.trim() === incomingWipTree.stdout.trim();
        if (!sourceEquivalent) {
          await this.runControllerCommand(
            sandbox,
            ["git", "reset", "--hard"],
            WORKSPACE_ROOT,
            signal,
          );
          await this.runControllerCommand(
            sandbox,
            [
              "git",
              "clean",
              "-ffdx",
              ...PRESERVED_CACHE_PATHS.flatMap(cachePath => ["-e", cachePath]),
            ],
            WORKSPACE_ROOT,
            signal,
          );
        }
      }
      await this.runControllerCommand(
        sandbox,
        ["git", "remote", "set-url", "origin", BLOCKED_GIT_REMOTE],
        WORKSPACE_ROOT,
        signal,
      );
      if (sourceEquivalent) {
        await this.runControllerCommand(
          sandbox,
          ["git", "reset", "--soft", branchHead],
          WORKSPACE_ROOT,
          signal,
        );
      } else {
        await this.runControllerCommand(
          sandbox,
          ["git", "checkout", "-B", branch, branchHead],
          WORKSPACE_ROOT,
          signal,
        );
        await this.runControllerCommand(
          sandbox,
          ["git", "reset", "--hard", branchHead],
          WORKSPACE_ROOT,
          signal,
        );
        await this.runControllerCommand(
          sandbox,
          ["git", "read-tree", "--reset", "-u", `${wipOid}^{tree}`],
          WORKSPACE_ROOT,
          signal,
        );
      }
      await this.verifyRepositorySnapshot(
        sandbox,
        { branch, branchHead, wipOid },
        signal,
      );
    } finally {
      await sandbox.files
        .remove(bundlePath, { user: this.user })
        .catch(() => undefined);
    }
  }

  async captureFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<SandboxCapture> {
    const sandbox = await this.secureConnect(sandboxId, signal);
    const captureManifest = await this.completeCaptureManifest(sandbox, signal);
    const files: SandboxFile[] = [];
    const excludedPaths = [...captureManifest.excludedPaths];
    let capturedBytes = 0;
    for (const entry of captureManifest.entries) {
      if (entry.type !== FileType.FILE) continue;
      const filePath = normalizeSandboxFilePath(entry.path);
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
  ): Promise<{ entries: EntryInfo[]; excludedPaths: string[] }> {
    const options = { signal, user: this.user };
    const traversed: EntryInfo[] = [];
    const traversedManifest = new Map<string, string>();
    const excludedPaths: string[] = [];
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
        if (!isAppV2SessionFileEligible(relative)) {
          excludedPaths.push(relative);
          continue;
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
    return {
      entries: traversed,
      excludedPaths: [...new Set(excludedPaths)].sort(),
    };
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
    const sandbox = await this.secureConnect(sandboxId, spec.signal);
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

  private async runControllerCommand(
    sandbox: E2BSandboxClient,
    argv: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    signal?.throwIfAborted();
    const handle = await sandbox.commands.run(
      e2bCommandForArgv(argv, this.user),
      {
        background: true,
        cwd,
        timeoutMs: 60_000,
        signal,
        user: this.user,
        envs: this.cleanEnvironment(),
      },
    );
    let termination: Promise<void> | undefined;
    const abort = (): void => {
      termination ??= this.terminateProcessGroup(sandbox, handle);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let result: CommandResult | undefined;
    let commandError: unknown;
    try {
      try {
        result = await handle.wait();
      } catch (error) {
        commandError = error;
      }
      await termination;
      signal?.throwIfAborted();
      if (commandError) throw commandError;
      if (!result) throw new Error("E2B controller command returned no result");
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async verifyRepositorySnapshot(
    sandbox: E2BSandboxClient,
    snapshot: Omit<SandboxRepositorySnapshot, "bundle">,
    signal?: AbortSignal,
  ): Promise<void> {
    const output = async (argv: readonly string[]): Promise<string> =>
      (
        await this.runControllerCommand(sandbox, argv, WORKSPACE_ROOT, signal)
      ).stdout.trim();
    const [branch, head, indexTree, wipTree, remotes, origin] =
      await Promise.all([
        output(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]),
        output(["git", "rev-parse", "--verify", "HEAD"]),
        output(["git", "write-tree"]),
        output(["git", "rev-parse", "--verify", `${snapshot.wipOid}^{tree}`]),
        output(["git", "remote"]),
        output(["git", "remote", "get-url", "origin"]),
        this.runControllerCommand(
          sandbox,
          ["git", "diff", "--quiet"],
          WORKSPACE_ROOT,
          signal,
        ),
      ]);
    if (
      branch !== snapshot.branch ||
      head !== snapshot.branchHead ||
      indexTree !== wipTree ||
      remotes !== "origin" ||
      origin !== BLOCKED_GIT_REMOTE
    ) {
      throw new AppV2ValidationError(
        "Sandbox Git worktree did not match the requested snapshot",
      );
    }
  }

  private cleanEnvironment(user = this.user): Record<string, string> {
    return {
      HOME: user === "root" ? "/root" : `/home/${user}`,
      PATH: user === "root" ? CLEAN_ROOT_PATH : CLEAN_PATH,
      BASH_ENV: "/dev/null",
    };
  }

  private async secureConnect(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<E2BSandboxClient> {
    const sandbox = await this.factory.connect(sandboxId, {
      apiKey: this.apiKey,
      signal,
    });
    try {
      await this.applyRuntimeIsolation(sandbox, signal);
      await this.assertConformance(sandbox, signal);
    } catch (error) {
      // A resumed sandbox is never left running when its firewall or tenant
      // conformance cannot be proven. Do not reuse the caller's possibly
      // aborted signal for fail-closed cleanup.
      await this.factory
        .kill(sandboxId, { apiKey: this.apiKey })
        .catch(() => undefined);
      throw new AppV2ValidationError(
        `E2B sandbox failed Apps v2 conformance/runtime isolation: ${
          error instanceof Error ? error.message : "unknown failure"
        }`,
      );
    }
    return sandbox;
  }

  private async applyRuntimeIsolation(
    sandbox: E2BSandboxClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const handle = await sandbox.commands.run(
      e2bCommandForArgv(["/bin/sh", "-c", RUNTIME_ISOLATION_SCRIPT], "root"),
      {
        background: true,
        timeoutMs: 10_000,
        signal,
        user: "root",
        envs: this.cleanEnvironment("root"),
      },
    );
    await handle.wait();
  }

  private async assertConformance(
    sandbox: E2BSandboxClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const handle = await sandbox.commands.run(
      e2bCommandForArgv(["/bin/sh", "-c", CONFORMANCE_SCRIPT], this.user),
      {
        background: true,
        timeoutMs: 10_000,
        signal,
        user: this.user,
        envs: this.cleanEnvironment(),
      },
    );
    await handle.wait();
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
    const sandbox = await this.secureConnect(sandboxId, signal);
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
      keepMemory: true,
      signal,
    });
  }

  async quiesce(sandboxId: string, signal?: AbortSignal): Promise<void> {
    const status = await this.status(sandboxId, signal);
    if (status === "missing") {
      throw new AppV2ValidationError("Cannot quiesce a missing E2B sandbox");
    }
    if (status === "paused") {
      // E2B full-memory auto-pause must be resumed before it can be converted
      // to a filesystem-only checkpoint.
      await this.secureConnect(sandboxId, signal);
    }
    const paused = await this.factory.pause(sandboxId, {
      apiKey: this.apiKey,
      keepMemory: false,
      signal,
    });
    if (!paused) {
      throw new AppV2ValidationError(
        "E2B did not confirm filesystem-only pause",
      );
    }
    await this.secureConnect(sandboxId, signal);
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
