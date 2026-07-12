import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile as readFileBytes,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppV2ScaffoldFile } from "@mako/schemas";
import {
  APP_V2_GIT_MAX_CONCURRENCY,
  APP_V2_GIT_MAX_OUTPUT_BYTES,
  APP_V2_GIT_TIMEOUT_MS,
  APP_V2_MAX_FILE_BYTES,
  APP_V2_MAX_FILES,
  APP_V2_MAX_TOTAL_BYTES,
  getAppsV2MaxRepositoryBytes,
} from "../config";
import {
  AppV2ConflictError,
  AppV2LimitError,
  AppV2NotFoundError,
  AppV2RecoveryConflictError,
  AppV2ValidationError,
} from "../errors";
import {
  assertNoAppV2CaseCollisions,
  validateAppV2Path,
} from "../path-validation";
import { loggers } from "../../logging";

const ZERO_OID = "0".repeat(40);
const REGULAR_MODE = "100644";
const EXECUTABLE_MODE = "100755";
const SYMLINK_MODE = "120000";
const logger = loggers.api("apps-v2-git");
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_PRUNE_RETENTION_MS = 24 * 60 * 60 * 1_000;

function appV2AbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Apps v2 Git operation aborted");
  error.name = "AbortError";
  return error;
}

class GitCommandSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= APP_V2_GIT_MAX_CONCURRENCY) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(appV2AbortError(signal as AbortSignal));
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.waiters.push(waiter);
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

const gitCommandSemaphore = new GitCommandSemaphore();
const maintenanceByRepository = new Map<string, Promise<void>>();
const lastMaintenanceByRepository = new Map<string, number>();

export function getAppV2ProcessTerminationTarget(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32" ? pid : -pid;
}

function terminateProcess(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    process.kill(getAppV2ProcessTerminationTarget(pid, platform), signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
}

export interface AppV2TreeEntry {
  path: string;
  oid: string;
  size: number;
  mode: "regular" | "executable";
}

export interface AppV2CommitStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface AppV2GitCommit {
  sha: string;
  treeSha: string;
  parentShas: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: Date;
  message: string;
  stats: AppV2CommitStats;
}

export interface AppV2MutationResult {
  wipOid: string;
  treeSha: string;
}

export interface AppV2ReplacementFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface AppV2GitLease {
  ref: string;
  oid: string;
  epoch: number;
  purpose: "active" | "deletion-fence";
}

export interface AppV2GitBundle {
  bytes: Buffer;
  branchHead: string;
  wipOid: string;
}

export function validateAppV2GitBranch(branch: string): string {
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.startsWith(".") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.split("/").some(part => !part || part.endsWith(".lock")) ||
    Array.from(branch).some(character => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127 || "~^:?*[\\".includes(character);
    })
  ) {
    throw new AppV2ValidationError("Invalid Apps v2 branch");
  }
  return branch;
}

export function validateAppV2GitOid(oid: string): string {
  if (!/^[a-f0-9]{40}$/.test(oid)) {
    throw new AppV2ValidationError("Invalid Apps v2 Git object ID");
  }
  return oid;
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
  input?: Buffer | string,
  extraEnvironment: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<GitResult> {
  const release = await gitCommandSemaphore.acquire(signal);
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.file.allow=never",
          "-c",
          "gc.autoDetach=false",
          ...args,
        ],
        {
          cwd: repositoryPath,
          detached: process.platform !== "win32",
          shell: false,
          env: {
            ...process.env,
            GIT_DIR: repositoryPath,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
            GIT_CONFIG_COUNT: "0",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_PARAMETERS: undefined,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_EXTERNAL_DIFF: undefined,
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_OBJECT_DIRECTORY: undefined,
            GIT_WORK_TREE: undefined,
            LC_ALL: "C",
            ...extraEnvironment,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let forcedError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (signal: NodeJS.Signals): void => {
        if (!child.pid) return;
        terminateProcess(child.pid, signal);
      };
      const forceTerminate = (error: Error): void => {
        if (forcedError) return;
        forcedError = error;
        terminate("SIGTERM");
        killTimer = setTimeout(() => terminate("SIGKILL"), 1_000);
        killTimer.unref();
      };
      const abort = (): void => {
        forceTerminate(appV2AbortError(signal as AbortSignal));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const capture = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > APP_V2_GIT_MAX_OUTPUT_BYTES) {
          forceTerminate(
            new AppV2LimitError("Git command output exceeded limit"),
          );
          return;
        }
        target.push(chunk);
      };
      const timeout = setTimeout(
        () => forceTerminate(new Error("Git command timed out")),
        APP_V2_GIT_TIMEOUT_MS,
      );
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.on("error", error => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", code => {
        clearTimeout(timeout);
        if (killTimer && !forcedError) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        const result = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        };
        if (forcedError) {
          reject(forcedError);
          return;
        }
        if (code === 0) {
          resolve(result);
          return;
        }
        reject(
          new Error(
            `Git ${args[0] ?? "command"} failed (${code ?? "signal"}): ${result.stderr.toString("utf8").trim()}`,
          ),
        );
      });
      child.stdin.on("error", error => {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
          forceTerminate(error);
        }
      });
      child.stdin.end(input);
    });
  } finally {
    release();
  }
}

function oidFrom(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

function indexEnvironment(indexPath: string): NodeJS.ProcessEnv {
  return {
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: path.dirname(indexPath),
  };
}

function modeName(mode: string): "regular" | "executable" {
  if (mode === REGULAR_MODE) return "regular";
  if (mode === EXECUTABLE_MODE) return "executable";
  if (mode === SYMLINK_MODE) {
    throw new AppV2ValidationError("Symlinks are not supported");
  }
  throw new AppV2ValidationError(`Unsupported Git file mode: ${mode}`);
}

async function directorySizeBytes(
  directoryPath: string,
  stopAfterBytes: number,
): Promise<number> {
  let total = 0;
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath, stopAfterBytes - total);
    } else {
      total += (await lstat(entryPath)).size;
    }
    if (total > stopAfterBytes) return total;
  }
  return total;
}

export class AppV2GitProvider {
  private readonly maxRepositoryBytes: number;
  private readonly maxBundleBytes: number;
  private readonly maintenanceIntervalMs: number;
  private readonly pruneRetentionMs: number;

  constructor(
    private readonly root: string,
    options: {
      maxRepositoryBytes?: number;
      maxBundleBytes?: number;
      maintenanceIntervalMs?: number;
      pruneRetentionMs?: number;
    } = {},
  ) {
    this.maxRepositoryBytes =
      options.maxRepositoryBytes ?? getAppsV2MaxRepositoryBytes();
    this.maxBundleBytes = options.maxBundleBytes ?? this.maxRepositoryBytes;
    this.maintenanceIntervalMs =
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.pruneRetentionMs =
      options.pruneRetentionMs ?? DEFAULT_PRUNE_RETENTION_MS;
  }

  repositoryPath(repositoryId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(repositoryId)) {
      throw new AppV2ValidationError("Invalid repository ID");
    }
    return path.join(this.root, `${repositoryId}.git`);
  }

  async createRepository(
    repositoryId: string,
    files: readonly AppV2ScaffoldFile[],
  ): Promise<AppV2GitCommit> {
    assertNoAppV2CaseCollisions(files.map(file => file.path));
    const scaffoldBytes = files.reduce(
      (total, file) => total + Buffer.byteLength(file.contents, "utf8"),
      0,
    );
    if (scaffoldBytes > this.maxRepositoryBytes) {
      throw new AppV2LimitError("Repository exceeds the Apps v2 storage quota");
    }
    const repositoryPath = this.repositoryPath(repositoryId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(repositoryPath, { mode: 0o700 });
    try {
      await runGit(repositoryPath, [
        "init",
        "--bare",
        "--object-format=sha1",
        "--initial-branch=main",
      ]);
      const treeSha = await this.createTree(
        repositoryPath,
        null,
        async index => {
          for (const file of files) {
            const content = Buffer.from(file.contents, "utf8");
            this.assertFileSize(content);
            const blobOid = oidFrom(
              await runGit(
                repositoryPath,
                ["hash-object", "-w", "--stdin"],
                content,
              ),
            );
            await runGit(
              repositoryPath,
              [
                "update-index",
                "--add",
                "--cacheinfo",
                file.executable ? EXECUTABLE_MODE : REGULAR_MODE,
                blobOid,
                validateAppV2Path(file.path),
              ],
              undefined,
              indexEnvironment(index),
            );
          }
        },
      );
      const commitSha = await this.createCommitObject(
        repositoryPath,
        treeSha,
        [],
        "Initial Mako Apps v2 scaffold",
      );
      await this.assertRepositoryQuota(repositoryPath);
      await runGit(repositoryPath, [
        "update-ref",
        "refs/heads/main",
        commitSha,
        ZERO_OID,
      ]);
      await runGit(repositoryPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await this.runScheduledMaintenance(repositoryId);
      return this.getCommit(repositoryId, commitSha);
    } catch (error) {
      await rm(repositoryPath, { recursive: true, force: true });
      throw error;
    }
  }

  async deleteRepository(repositoryId: string): Promise<void> {
    await rm(this.repositoryPath(repositoryId), {
      recursive: true,
      force: true,
    });
  }

  async resolveRef(
    repositoryId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertManagedRef(ref);
    const result = await runGit(
      this.repositoryPath(repositoryId),
      ["rev-parse", "--verify", ref],
      undefined,
      {},
      signal,
    );
    return oidFrom(result);
  }

  async resolveBranch(
    repositoryId: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.resolveRef(repositoryId, this.branchRef(branch), signal);
  }

  async createBundle(
    repositoryId: string,
    refs: { branch: string; wipRef: string },
    signal?: AbortSignal,
  ): Promise<AppV2GitBundle> {
    signal?.throwIfAborted();
    const repositoryPath = this.repositoryPath(repositoryId);
    const branchRef = this.branchRef(refs.branch);
    this.assertWorktreeRef(refs.wipRef);
    const [branchHead, wipOid] = await Promise.all([
      this.resolveRef(repositoryId, branchRef, signal),
      this.resolveRef(repositoryId, refs.wipRef, signal),
    ]);
    signal?.throwIfAborted();
    validateAppV2GitOid(branchHead);
    validateAppV2GitOid(wipOid);
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "mako-app-v2-bundle-"),
    );
    const bundlePath = path.join(temporaryDirectory, "repository.bundle");
    try {
      signal?.throwIfAborted();
      await runGit(
        repositoryPath,
        ["bundle", "create", bundlePath, branchRef, refs.wipRef],
        undefined,
        {},
        signal,
      );
      signal?.throwIfAborted();
      const bundleSize = (await stat(bundlePath)).size;
      if (bundleSize > this.maxBundleBytes) {
        throw new AppV2LimitError("Git bundle exceeds the Apps v2 size limit");
      }
      const listed = await runGit(
        repositoryPath,
        ["bundle", "list-heads", bundlePath],
        undefined,
        {},
        signal,
      );
      const heads = new Map(
        listed.stdout
          .toString("utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => {
            const match = /^([a-f0-9]{40}) (refs\/\S+)$/.exec(line);
            if (!match) {
              throw new AppV2ValidationError(
                "Git bundle contains an invalid reference",
              );
            }
            return [match[2], match[1]] as const;
          }),
      );
      if (
        heads.size !== 2 ||
        heads.get(branchRef) !== branchHead ||
        heads.get(refs.wipRef) !== wipOid
      ) {
        throw new AppV2ConflictError(
          "Branch or worktree changed while creating Git bundle",
        );
      }
      const bytes = await readFileBytes(bundlePath, { signal });
      signal?.throwIfAborted();
      if (bytes.byteLength > this.maxBundleBytes) {
        throw new AppV2LimitError("Git bundle exceeds the Apps v2 size limit");
      }
      return { bytes, branchHead, wipOid };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async ensureBranch(
    repositoryId: string,
    branch: string,
    startSha: string,
  ): Promise<string> {
    const repositoryPath = this.repositoryPath(repositoryId);
    const ref = this.branchRef(branch);
    const existing = await this.resolveRefByPath(repositoryPath, ref);
    if (existing) return existing;
    try {
      await runGit(repositoryPath, ["update-ref", ref, startSha, ZERO_OID]);
      return startSha;
    } catch {
      const concurrentlyCreated = await this.resolveRefByPath(
        repositoryPath,
        ref,
      );
      if (concurrentlyCreated) return concurrentlyCreated;
      throw new AppV2ConflictError("Branch changed concurrently");
    }
  }

  async createWorktreeRef(
    repositoryId: string,
    worktreeId: string,
    baseSha: string,
  ): Promise<{
    wipRef: string;
    wipOid: string;
    leaseRef: string;
    leaseOid: string;
  }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(worktreeId)) {
      throw new AppV2ValidationError("Invalid worktree ID");
    }
    const repositoryPath = this.repositoryPath(repositoryId);
    const wipRef = `refs/mako/worktrees/${worktreeId}`;
    const leaseRef = `refs/mako/leases/${worktreeId}`;
    const leaseOid = await this.createLeaseObject(repositoryPath, 1, "active");
    const transaction = [
      "start",
      `update ${wipRef} ${baseSha} ${ZERO_OID}`,
      `update ${leaseRef} ${leaseOid} ${ZERO_OID}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      throw new AppV2ConflictError("Worktree refs changed concurrently");
    }
    await this.runScheduledMaintenance(repositoryId);
    return { wipRef, wipOid: baseSha, leaseRef, leaseOid };
  }

  async getLease(
    repositoryId: string,
    leaseRef: string,
  ): Promise<AppV2GitLease> {
    const repositoryPath = this.repositoryPath(repositoryId);
    this.assertLeaseRef(leaseRef);
    const oid = await this.resolveRef(repositoryId, leaseRef);
    const result = await runGit(repositoryPath, ["cat-file", "blob", oid]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      throw new AppV2ValidationError("Invalid Apps v2 lease object");
    }
    const epoch =
      typeof parsed === "object" &&
      parsed !== null &&
      "epoch" in parsed &&
      typeof parsed.epoch === "number"
        ? parsed.epoch
        : undefined;
    const purpose =
      typeof parsed === "object" &&
      parsed !== null &&
      "purpose" in parsed &&
      parsed.purpose === "deletion-fence"
        ? "deletion-fence"
        : "active";
    if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw new AppV2ValidationError("Invalid Apps v2 lease epoch");
    }
    return { ref: leaseRef, oid, epoch, purpose };
  }

  async rotateLease(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    leaseRef: string,
    expectedLeaseOid: string,
    nextEpoch: number,
  ): Promise<AppV2GitLease> {
    this.assertWorktreeAndLeaseRefs(wipRef, leaseRef);
    return this.advanceLease(
      repositoryId,
      leaseRef,
      expectedLeaseOid,
      nextEpoch,
      "active",
      [`verify ${wipRef} ${expectedWipOid}`],
    );
  }

  async fenceLease(
    repositoryId: string,
    leaseRef: string,
    expectedLeaseOid: string,
    nextEpoch: number,
  ): Promise<AppV2GitLease> {
    return this.advanceLease(
      repositoryId,
      leaseRef,
      expectedLeaseOid,
      nextEpoch,
      "deletion-fence",
      [],
    );
  }

  async tree(
    repositoryId: string,
    revision: string,
  ): Promise<AppV2TreeEntry[]> {
    const result = await runGit(this.repositoryPath(repositoryId), [
      "ls-tree",
      "-r",
      "-z",
      "-l",
      revision,
    ]);
    const entries = result.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(record => {
        const match = /^(\d{6}) blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(record);
        if (!match) {
          throw new AppV2ValidationError(
            "Repository contains unsupported entries",
          );
        }
        const [, rawMode, oid, rawSize, entryPath] = match;
        return {
          path: validateAppV2Path(entryPath),
          oid,
          size: Number(rawSize),
          mode: modeName(rawMode),
        };
      });
    assertNoAppV2CaseCollisions(entries.map(entry => entry.path));
    this.assertTreeLimits(entries);
    return entries;
  }

  async readFile(
    repositoryId: string,
    revision: string,
    filePath: string,
  ): Promise<{ content: Buffer; entry: AppV2TreeEntry }> {
    const validatedPath = validateAppV2Path(filePath);
    const entry = (await this.tree(repositoryId, revision)).find(
      candidate => candidate.path === validatedPath,
    );
    if (!entry) throw new AppV2NotFoundError("File not found");
    const result = await runGit(this.repositoryPath(repositoryId), [
      "cat-file",
      "blob",
      entry.oid,
    ]);
    this.assertFileSize(result.stdout);
    return { content: result.stdout, entry };
  }

  async writeFile(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    baseSha: string,
    leaseRef: string,
    expectedLeaseOid: string,
    filePath: string,
    content: Buffer,
    executable: boolean,
  ): Promise<AppV2MutationResult> {
    const validatedPath = validateAppV2Path(filePath);
    this.assertFileSize(content);
    const existingEntries = await this.tree(repositoryId, expectedWipOid);
    assertNoAppV2CaseCollisions([
      ...existingEntries
        .filter(entry => entry.path !== validatedPath)
        .map(entry => entry.path),
      validatedPath,
    ]);
    const repositoryPath = this.repositoryPath(repositoryId);
    await this.assertRepositoryQuota(repositoryPath, content.byteLength);
    const blobOid = oidFrom(
      await runGit(repositoryPath, ["hash-object", "-w", "--stdin"], content),
    );
    const treeSha = await this.createTree(
      repositoryPath,
      expectedWipOid,
      async index => {
        await runGit(
          repositoryPath,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            executable ? EXECUTABLE_MODE : REGULAR_MODE,
            blobOid,
            validatedPath,
          ],
          undefined,
          indexEnvironment(index),
        );
      },
    );
    return this.advanceWip(
      repositoryId,
      wipRef,
      expectedWipOid,
      baseSha,
      leaseRef,
      expectedLeaseOid,
      treeSha,
      `WIP write ${validatedPath}`,
    );
  }

  async replaceWorktreeTree(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    baseSha: string,
    leaseRef: string,
    expectedLeaseOid: string,
    files: readonly AppV2ReplacementFile[],
    recoveryId?: string,
  ): Promise<AppV2MutationResult> {
    const paths = files.map(file => validateAppV2Path(file.path));
    assertNoAppV2CaseCollisions(paths);
    if (files.length > APP_V2_MAX_FILES) {
      throw new AppV2LimitError("Project exceeds the Apps v2 file-count limit");
    }
    let totalBytes = 0;
    for (const file of files) {
      this.assertFileSize(file.content);
      totalBytes += file.content.byteLength;
    }
    if (totalBytes > APP_V2_MAX_TOTAL_BYTES) {
      throw new AppV2LimitError("Project exceeds the Apps v2 total-size limit");
    }
    const repositoryPath = this.repositoryPath(repositoryId);
    await this.assertRepositoryQuota(repositoryPath, totalBytes);
    const blobs = await Promise.all(
      files.map(async (file, index) => ({
        path: paths[index],
        executable: file.executable,
        oid: oidFrom(
          await runGit(
            repositoryPath,
            ["hash-object", "-w", "--stdin"],
            file.content,
          ),
        ),
      })),
    );
    const treeSha = await this.createTree(repositoryPath, null, async index => {
      for (const file of blobs) {
        await runGit(
          repositoryPath,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            file.executable ? EXECUTABLE_MODE : REGULAR_MODE,
            file.oid,
            file.path,
          ],
          undefined,
          indexEnvironment(index),
        );
      }
    });
    return this.advanceWip(
      repositoryId,
      wipRef,
      expectedWipOid,
      baseSha,
      leaseRef,
      expectedLeaseOid,
      treeSha,
      recoveryId
        ? `WIP replace sandbox source tree (${recoveryId})`
        : "WIP replace sandbox source tree",
      this.worktreeIdFromRef(wipRef),
      recoveryId,
    );
  }

  async deleteFile(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    baseSha: string,
    leaseRef: string,
    expectedLeaseOid: string,
    filePath: string,
  ): Promise<AppV2MutationResult> {
    const validatedPath = validateAppV2Path(filePath);
    const entries = await this.tree(repositoryId, expectedWipOid);
    if (!entries.some(entry => entry.path === validatedPath)) {
      throw new AppV2NotFoundError("File not found");
    }
    const repositoryPath = this.repositoryPath(repositoryId);
    const treeSha = await this.createTree(
      repositoryPath,
      expectedWipOid,
      async index => {
        await runGit(
          repositoryPath,
          ["update-index", "--force-remove", "--", validatedPath],
          undefined,
          indexEnvironment(index),
        );
      },
    );
    return this.advanceWip(
      repositoryId,
      wipRef,
      expectedWipOid,
      baseSha,
      leaseRef,
      expectedLeaseOid,
      treeSha,
      `WIP delete ${validatedPath}`,
    );
  }

  async moveFile(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    baseSha: string,
    leaseRef: string,
    expectedLeaseOid: string,
    fromPath: string,
    toPath: string,
  ): Promise<AppV2MutationResult> {
    const from = validateAppV2Path(fromPath);
    const to = validateAppV2Path(toPath);
    if (from === to) throw new AppV2ValidationError("Paths must be different");
    const entries = await this.tree(repositoryId, expectedWipOid);
    const source = entries.find(entry => entry.path === from);
    if (!source) throw new AppV2NotFoundError("Source file not found");
    if (entries.some(entry => entry.path === to)) {
      throw new AppV2ValidationError("Destination already exists");
    }
    assertNoAppV2CaseCollisions([
      ...entries.filter(entry => entry.path !== from).map(entry => entry.path),
      to,
    ]);
    const repositoryPath = this.repositoryPath(repositoryId);
    const treeSha = await this.createTree(
      repositoryPath,
      expectedWipOid,
      async index => {
        await runGit(
          repositoryPath,
          ["update-index", "--force-remove", "--", from],
          undefined,
          indexEnvironment(index),
        );
        await runGit(
          repositoryPath,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            source.mode === "executable" ? EXECUTABLE_MODE : REGULAR_MODE,
            source.oid,
            to,
          ],
          undefined,
          indexEnvironment(index),
        );
      },
    );
    return this.advanceWip(
      repositoryId,
      wipRef,
      expectedWipOid,
      baseSha,
      leaseRef,
      expectedLeaseOid,
      treeSha,
      `WIP move ${from} to ${to}`,
    );
  }

  async status(
    repositoryId: string,
    baseSha: string,
    wipOid: string,
  ): Promise<Array<{ path: string; previousPath?: string; status: string }>> {
    const result = await runGit(this.repositoryPath(repositoryId), [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "-M",
      baseSha,
      wipOid,
    ]);
    const fields = result.stdout.toString("utf8").split("\0").filter(Boolean);
    const changes: Array<{
      path: string;
      previousPath?: string;
      status: string;
    }> = [];
    for (let index = 0; index < fields.length; index += 2) {
      const code = fields[index];
      if (code.startsWith("R")) {
        changes.push({
          status: "renamed",
          previousPath: validateAppV2Path(fields[index + 1]),
          path: validateAppV2Path(fields[index + 2]),
        });
        index += 1;
      } else {
        changes.push({
          status:
            code === "A" ? "added" : code === "D" ? "deleted" : "modified",
          path: validateAppV2Path(fields[index + 1]),
        });
      }
    }
    return changes;
  }

  async discard(
    repositoryId: string,
    branch: string,
    expectedBranchOid: string,
    wipRef: string,
    expectedWipOid: string,
    leaseRef: string,
    expectedLeaseOid: string,
  ): Promise<AppV2MutationResult> {
    const repositoryPath = this.repositoryPath(repositoryId);
    const branchRef = this.branchRef(branch);
    this.assertWorktreeAndLeaseRefs(wipRef, leaseRef);
    const transaction = [
      "start",
      `verify ${branchRef} ${expectedBranchOid}`,
      `verify ${leaseRef} ${expectedLeaseOid}`,
      `update ${wipRef} ${expectedBranchOid} ${expectedWipOid}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      throw new AppV2ConflictError(
        "Branch, lease, or worktree changed concurrently",
      );
    }
    const treeSha = oidFrom(
      await runGit(repositoryPath, [
        "rev-parse",
        `${expectedBranchOid}^{tree}`,
      ]),
    );
    await this.runScheduledMaintenance(repositoryId);
    return { wipOid: expectedBranchOid, treeSha };
  }

  async fastForwardCleanWorktree(
    repositoryId: string,
    branch: string,
    expectedBranchOid: string,
    wipRef: string,
    expectedWipOid: string,
    leaseRef: string,
    expectedLeaseOid: string,
  ): Promise<string> {
    const repositoryPath = this.repositoryPath(repositoryId);
    this.assertWorktreeAndLeaseRefs(wipRef, leaseRef);
    const transaction = [
      "start",
      `verify ${this.branchRef(branch)} ${expectedBranchOid}`,
      `verify ${leaseRef} ${expectedLeaseOid}`,
      `update ${wipRef} ${expectedBranchOid} ${expectedWipOid}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      throw new AppV2ConflictError(
        "Branch, lease, or worktree changed concurrently",
      );
    }
    return expectedBranchOid;
  }

  async commit(
    repositoryId: string,
    branch: string,
    wipRef: string,
    expectedWipOid: string,
    expectedBranchOid: string,
    leaseRef: string,
    expectedLeaseOid: string,
    message: string,
  ): Promise<AppV2GitCommit> {
    const repositoryPath = this.repositoryPath(repositoryId);
    const branchRef = this.branchRef(branch);
    this.assertWorktreeAndLeaseRefs(wipRef, leaseRef);
    await this.assertRepositoryQuota(repositoryPath);
    const treeSha = oidFrom(
      await runGit(repositoryPath, ["rev-parse", `${expectedWipOid}^{tree}`]),
    );
    const commitSha = await this.createCommitObject(
      repositoryPath,
      treeSha,
      [expectedBranchOid],
      message,
    );
    await this.assertRepositoryQuota(repositoryPath);
    const transaction = [
      "start",
      `verify ${leaseRef} ${expectedLeaseOid}`,
      `update ${branchRef} ${commitSha} ${expectedBranchOid}`,
      `update ${wipRef} ${commitSha} ${expectedWipOid}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      throw new AppV2ConflictError(
        "Branch, lease, or worktree changed concurrently",
      );
    }
    await this.runScheduledMaintenance(repositoryId);
    return this.getCommit(repositoryId, commitSha);
  }

  async listCommits(
    repositoryId: string,
    ref: string,
    limit: number,
  ): Promise<AppV2GitCommit[]> {
    const result = await runGit(this.repositoryPath(repositoryId), [
      "rev-list",
      `--max-count=${Math.min(Math.max(limit, 1), 100)}`,
      ref,
    ]);
    const shas = result.stdout.toString("utf8").split("\n").filter(Boolean);
    return Promise.all(shas.map(sha => this.getCommit(repositoryId, sha)));
  }

  async isAncestor(
    repositoryId: string,
    ancestorSha: string,
    descendantRef: string,
  ): Promise<boolean> {
    try {
      await runGit(this.repositoryPath(repositoryId), [
        "merge-base",
        "--is-ancestor",
        ancestorSha,
        descendantRef,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async getCommit(repositoryId: string, sha: string): Promise<AppV2GitCommit> {
    const repositoryPath = this.repositoryPath(repositoryId);
    let result: GitResult;
    try {
      result = await runGit(repositoryPath, [
        "show",
        "-s",
        "--format=%H%n%T%n%P%n%an%n%ae%n%at%n%B",
        "--end-of-options",
        sha,
      ]);
    } catch {
      throw new AppV2NotFoundError("Commit not found");
    }
    const [
      commitSha,
      treeSha,
      parents,
      authorName,
      authorEmail,
      timestamp,
      ...body
    ] = result.stdout.toString("utf8").split("\n");
    return {
      sha: commitSha,
      treeSha,
      parentShas: parents ? parents.split(" ") : [],
      authorName,
      authorEmail,
      authoredAt: new Date(Number(timestamp) * 1_000),
      message: body.join("\n").trimEnd(),
      stats: await this.commitStats(repositoryPath, commitSha, parents),
    };
  }

  private async advanceLease(
    repositoryId: string,
    leaseRef: string,
    expectedLeaseOid: string,
    nextEpoch: number,
    purpose: AppV2GitLease["purpose"],
    extraVerifications: readonly string[],
  ): Promise<AppV2GitLease> {
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 1) {
      throw new AppV2ValidationError("Invalid Apps v2 lease epoch");
    }
    this.assertLeaseRef(leaseRef);
    const repositoryPath = this.repositoryPath(repositoryId);
    const leaseOid = await this.createLeaseObject(
      repositoryPath,
      nextEpoch,
      purpose,
    );
    const transaction = [
      "start",
      ...extraVerifications,
      `update ${leaseRef} ${leaseOid} ${expectedLeaseOid}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      throw new AppV2ConflictError("Lease changed concurrently");
    }
    await this.runScheduledMaintenance(repositoryId);
    return { ref: leaseRef, oid: leaseOid, epoch: nextEpoch, purpose };
  }

  private async advanceWip(
    repositoryId: string,
    wipRef: string,
    expectedWipOid: string,
    baseSha: string,
    leaseRef: string,
    expectedLeaseOid: string,
    treeSha: string,
    message: string,
    recoveryWorktreeId?: string,
    recoveryId?: string,
  ): Promise<AppV2MutationResult> {
    this.assertWorktreeAndLeaseRefs(wipRef, leaseRef);
    const repositoryPath = this.repositoryPath(repositoryId);
    await this.assertRepositoryQuota(repositoryPath);
    const entries = await this.tree(repositoryId, treeSha);
    this.assertTreeLimits(entries);
    const wipOid = await this.createCommitObject(
      repositoryPath,
      treeSha,
      [baseSha],
      message,
    );
    await this.assertRepositoryQuota(repositoryPath);
    const successRef =
      recoveryWorktreeId && recoveryId
        ? this.successRefName(recoveryWorktreeId, recoveryId)
        : undefined;
    const transaction = [
      "start",
      `verify ${leaseRef} ${expectedLeaseOid}`,
      `update ${wipRef} ${wipOid} ${expectedWipOid}`,
      ...(successRef ? [`create ${successRef} ${wipOid}`] : []),
      "prepare",
      "commit",
      "",
    ].join("\n");
    try {
      await runGit(repositoryPath, ["update-ref", "--stdin"], transaction);
    } catch {
      if (recoveryWorktreeId && recoveryId) {
        const recoveryRef = await this.createRecoveryRef(
          repositoryPath,
          recoveryWorktreeId,
          recoveryId,
          wipOid,
        );
        throw new AppV2RecoveryConflictError(
          "Lease or worktree changed concurrently",
          recoveryRef,
        );
      }
      throw new AppV2ConflictError("Lease or worktree changed concurrently");
    }
    await this.runScheduledMaintenance(repositoryId);
    return { wipOid, treeSha };
  }

  private worktreeIdFromRef(wipRef: string): string {
    const match = /^refs\/mako\/worktrees\/([a-zA-Z0-9_-]+)$/.exec(wipRef);
    if (!match) throw new AppV2ValidationError("Invalid Apps v2 worktree ref");
    return match[1];
  }

  private assertWorktreeAndLeaseRefs(wipRef: string, leaseRef: string): void {
    this.assertWorktreeRef(wipRef);
    this.assertLeaseRef(leaseRef);
    if (
      wipRef.slice("refs/mako/worktrees/".length) !==
      leaseRef.slice("refs/mako/leases/".length)
    ) {
      throw new AppV2ValidationError("Apps v2 worktree refs do not match");
    }
  }

  private assertWorktreeRef(wipRef: string): void {
    if (!/^refs\/mako\/worktrees\/[a-zA-Z0-9_-]+$/.test(wipRef)) {
      throw new AppV2ValidationError("Invalid Apps v2 worktree ref");
    }
  }

  private assertLeaseRef(leaseRef: string): void {
    if (!/^refs\/mako\/leases\/[a-zA-Z0-9_-]+$/.test(leaseRef)) {
      throw new AppV2ValidationError("Invalid Apps v2 lease ref");
    }
  }

  private assertManagedRef(ref: string): void {
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      if (this.branchRef(branch) === ref) return;
    }
    if (
      /^refs\/mako\/(?:worktrees|leases)\/[a-zA-Z0-9_-]+$/.test(ref) ||
      /^refs\/mako\/(?:recovery|session-success)\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}$/.test(
        ref,
      )
    ) {
      return;
    }
    throw new AppV2ValidationError("Invalid Apps v2 Git ref");
  }

  private branchRef(branch: string): string {
    return `refs/heads/${validateAppV2GitBranch(branch)}`;
  }

  private async createRecoveryRef(
    repositoryPath: string,
    worktreeId: string,
    recoveryId: string,
    wipOid: string,
  ): Promise<string> {
    const recoveryRef = this.recoveryRefName(worktreeId, recoveryId);
    try {
      await runGit(repositoryPath, [
        "update-ref",
        recoveryRef,
        wipOid,
        ZERO_OID,
      ]);
      return recoveryRef;
    } catch {
      const existing = await this.resolveRefByPath(repositoryPath, recoveryRef);
      if (existing === wipOid) return recoveryRef;
      throw new Error("Failed to preserve sandbox capture recovery ref");
    }
  }

  recoveryRefName(worktreeId: string, recoveryId: string): string {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(worktreeId) ||
      !/^[a-f0-9]{64}$/.test(recoveryId)
    ) {
      throw new AppV2ValidationError("Invalid Apps v2 recovery identity");
    }
    return `refs/mako/recovery/${worktreeId}/${recoveryId}`;
  }

  successRefName(worktreeId: string, recoveryId: string): string {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(worktreeId) ||
      !/^[a-f0-9]{64}$/.test(recoveryId)
    ) {
      throw new AppV2ValidationError("Invalid Apps v2 recovery identity");
    }
    return `refs/mako/session-success/${worktreeId}/${recoveryId}`;
  }

  async findRecoveryRef(
    repositoryId: string,
    worktreeId: string,
    recoveryId: string,
  ): Promise<string | null> {
    const recoveryRef = this.recoveryRefName(worktreeId, recoveryId);
    const oid = await this.resolveRefByPath(
      this.repositoryPath(repositoryId),
      recoveryRef,
    );
    return oid ? recoveryRef : null;
  }

  async findSuccessMarker(
    repositoryId: string,
    worktreeId: string,
    recoveryId: string,
  ): Promise<{ ref: string; oid: string } | null> {
    const ref = this.successRefName(worktreeId, recoveryId);
    const oid = await this.resolveRefByPath(
      this.repositoryPath(repositoryId),
      ref,
    );
    return oid ? { ref, oid } : null;
  }

  async deleteSuccessMarker(
    repositoryId: string,
    worktreeId: string,
    recoveryId: string,
    expectedWipOid: string,
  ): Promise<void> {
    const repositoryPath = this.repositoryPath(repositoryId);
    const ref = this.successRefName(worktreeId, recoveryId);
    const current = await this.resolveRefByPath(repositoryPath, ref);
    if (!current) return;
    if (current !== expectedWipOid) {
      throw new AppV2ConflictError("Session success marker changed");
    }
    await runGit(repositoryPath, ["update-ref", "-d", ref, expectedWipOid]);
  }

  private async resolveRefByPath(
    repositoryPath: string,
    ref: string,
  ): Promise<string | null> {
    this.assertManagedRef(ref);
    try {
      return oidFrom(
        await runGit(repositoryPath, ["show-ref", "--verify", "--hash", ref]),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("Git show-ref failed (1):") ||
          (error.message.startsWith("Git show-ref failed (128):") &&
            error.message.endsWith(" - not a valid ref")))
      ) {
        return null;
      }
      throw error;
    }
  }

  private async createTree(
    repositoryPath: string,
    baseRevision: string | null,
    mutate: (indexPath: string) => Promise<void>,
  ): Promise<string> {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "mako-app-v2-index-"),
    );
    const indexPath = path.join(temporaryDirectory, "index");
    try {
      await runGit(
        repositoryPath,
        baseRevision ? ["read-tree", baseRevision] : ["read-tree", "--empty"],
        undefined,
        indexEnvironment(indexPath),
      );
      await mutate(indexPath);
      return oidFrom(
        await runGit(
          repositoryPath,
          ["write-tree"],
          undefined,
          indexEnvironment(indexPath),
        ),
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async createCommitObject(
    repositoryPath: string,
    treeSha: string,
    parentShas: readonly string[],
    message: string,
  ): Promise<string> {
    const parentArgs = parentShas.flatMap(parent => ["-p", parent]);
    const result = await runGit(
      repositoryPath,
      ["commit-tree", treeSha, ...parentArgs, "-F", "-"],
      `${message.trim()}\n`,
      {
        GIT_AUTHOR_NAME: "Mako Apps v2",
        GIT_AUTHOR_EMAIL: "apps-v2@mako.local",
        GIT_COMMITTER_NAME: "Mako Apps v2",
        GIT_COMMITTER_EMAIL: "apps-v2@mako.local",
      },
    );
    return oidFrom(result);
  }

  private async createLeaseObject(
    repositoryPath: string,
    epoch: number,
    purpose: AppV2GitLease["purpose"],
  ): Promise<string> {
    const contents = JSON.stringify({
      epoch,
      purpose,
      nonce: randomUUID(),
      rotatedAt: new Date().toISOString(),
    });
    return oidFrom(
      await runGit(
        repositoryPath,
        ["hash-object", "-w", "--stdin"],
        `${contents}\n`,
      ),
    );
  }

  private async commitStats(
    repositoryPath: string,
    commitSha: string,
    parents: string,
  ): Promise<AppV2CommitStats> {
    const args = parents
      ? [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          parents.split(" ")[0],
          commitSha,
        ]
      : [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--numstat",
          "--format=",
          commitSha,
        ];
    const result = await runGit(repositoryPath, args);
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of result.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [added, deleted] = line.split("\t");
      filesChanged += 1;
      additions += added === "-" ? 0 : Number(added);
      deletions += deleted === "-" ? 0 : Number(deleted);
    }
    return { filesChanged, additions, deletions };
  }

  private async assertRepositoryQuota(
    repositoryPath: string,
    additionalBytes = 0,
  ): Promise<void> {
    const currentBytes = await directorySizeBytes(
      repositoryPath,
      this.maxRepositoryBytes,
    );
    if (currentBytes + additionalBytes > this.maxRepositoryBytes) {
      throw new AppV2LimitError("Repository exceeds the Apps v2 storage quota");
    }
  }

  async runScheduledMaintenance(
    repositoryId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const repositoryPath = this.repositoryPath(repositoryId);
    const now = Date.now();
    const lastMaintenance =
      lastMaintenanceByRepository.get(repositoryPath) ?? 0;
    if (!options.force && now - lastMaintenance < this.maintenanceIntervalMs) {
      return;
    }
    const existing = maintenanceByRepository.get(repositoryPath);
    if (existing) return existing;
    const retentionSeconds = Math.max(
      1,
      Math.ceil(this.pruneRetentionMs / 1_000),
    );
    // Never use immediate pruning. The positive retention window protects
    // objects created by in-flight writers/readers before their ref transaction
    // completes, while Git's own gc locks serialize cross-process maintenance.
    const expiry = `${retentionSeconds}.seconds.ago`;
    const maintenance = (async () => {
      try {
        await runGit(repositoryPath, [
          "reflog",
          "expire",
          "--expire=never",
          `--expire-unreachable=${expiry}`,
          "--all",
        ]);
        await runGit(repositoryPath, ["gc", `--prune=${expiry}`, "--quiet"]);
      } catch (error) {
        logger.warn("Apps v2 Git maintenance failed", {
          error,
          repositoryPath,
        });
      }
      await this.assertRepositoryQuota(repositoryPath);
      lastMaintenanceByRepository.set(repositoryPath, Date.now());
    })();
    maintenanceByRepository.set(repositoryPath, maintenance);
    try {
      await maintenance;
    } finally {
      if (maintenanceByRepository.get(repositoryPath) === maintenance) {
        maintenanceByRepository.delete(repositoryPath);
      }
    }
  }

  private assertFileSize(content: Buffer): void {
    if (content.byteLength > APP_V2_MAX_FILE_BYTES) {
      throw new AppV2LimitError("File exceeds the Apps v2 size limit");
    }
  }

  private assertTreeLimits(entries: readonly AppV2TreeEntry[]): void {
    if (entries.length > APP_V2_MAX_FILES) {
      throw new AppV2LimitError("Project exceeds the Apps v2 file-count limit");
    }
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes > APP_V2_MAX_TOTAL_BYTES) {
      throw new AppV2LimitError("Project exceeds the Apps v2 total-size limit");
    }
    for (const entry of entries) {
      if (entry.size > APP_V2_MAX_FILE_BYTES) {
        throw new AppV2LimitError("Project contains an oversized file");
      }
    }
  }
}
