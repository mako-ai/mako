/**
 * A read session as two local processes, for tests: the SDK runner in
 * `read --session` mode, piped into the real session supervisor
 * (session-supervisor.ts), batches in a temporary directory.
 *
 * It plays the box wrapper's part (session-isolation.ts `wrapperScript`):
 * when the runner exits, whatever it left running is killed, the supervisor
 * reads the rest, and the status line is written. Everything above the box
 * is the production code: `SandboxedConnector.fetchViaSession` and
 * session-read.ts's `endedOutcome` and `parseBatch`.
 *
 * There is no run user here, so it proves nothing about isolation; the
 * Docker suite does. It proves the session reads what chunk processes read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CONNECTOR_PROTOCOL_BYTES,
  MAX_CONNECTOR_PROTOCOL_MESSAGES,
} from "../sync-box";
import { SESSION_SUPERVISOR_SOURCE } from "../session-supervisor";
import {
  endedOutcome,
  parseBatch,
  type PullOutcome,
  type ReadSessionTransport,
  type SessionHandle,
  type SessionStart,
} from "../session-read";

interface Running {
  dir: string;
  runner: ChildProcess;
  ended: Promise<void>;
  stderr: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class LocalSessionTransport implements ReadSessionTransport {
  readonly sessions = new Map<string, Running>();
  /** Every call, for assertions: `start`, `pull <seq>`, `close`. */
  readonly calls: string[] = [];
  private supervisor: string | null = null;

  constructor(
    private readonly options: {
      /** The SDK runner, `bin/mako-connector.js`. */
      runner: string;
      /** The connector entry. */
      connector: string;
      cwd: string;
      buffer?: number;
      idleMs?: number;
    },
  ) {}

  private supervisorPath(): string {
    if (!this.supervisor) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-supervisor-"));
      this.supervisor = path.join(dir, "session-supervisor.mjs");
      fs.writeFileSync(this.supervisor, SESSION_SUPERVISOR_SOURCE);
    }
    return this.supervisor;
  }

  async start(
    input: SessionStart,
  ): Promise<{ handle: SessionHandle; outcome: PullOutcome }> {
    this.calls.push("start");
    const id = randomBytes(8).toString("hex");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-session-"));
    const run = path.join(dir, "run");
    fs.mkdirSync(path.join(dir, "batches"));
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(dir, "heartbeat"), "");
    const args = [
      this.options.runner,
      "read",
      "--connector",
      this.options.connector,
    ];
    const inputs: string[] = [];
    for (const [name, value] of [
      ["config", input.config],
      ["catalog", input.catalog],
      ["state", input.state],
    ] as const) {
      if (value === undefined) continue;
      const file = path.join(run, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(value));
      args.push(`--${name}`, file);
      inputs.push(file);
    }
    if (input.maxIterations !== undefined) {
      args.push("--max-iterations", String(input.maxIterations));
    }
    if (input.maxBytes !== undefined) {
      args.push("--max-bytes", String(input.maxBytes));
    }
    args.push("--session", ...(input.since ? ["--since", input.since] : []));

    const runner = spawn(process.execPath, args, {
      cwd: this.options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const supervisor = spawn(
      process.execPath,
      [
        this.supervisorPath(),
        "--dir",
        dir,
        "--kill-pgid",
        String(runner.pid),
        "--inputs",
        inputs.join(","),
        "--max-bytes",
        String(MAX_CONNECTOR_PROTOCOL_BYTES),
        "--max-messages",
        String(MAX_CONNECTOR_PROTOCOL_MESSAGES),
        "--buffer",
        String(this.options.buffer ?? 2),
        "--idle-ms",
        String(this.options.idleMs ?? 60_000),
        "--deadline",
        String(Date.now() + 60 * 60_000),
      ],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    runner.stdout?.pipe(supervisor.stdin as NodeJS.WritableStream);
    const running: Running = {
      dir,
      runner,
      ended: Promise.resolve(),
      stderr: "",
    };
    runner.stderr?.on("data", chunk => {
      if (running.stderr.length < 64_000) running.stderr += String(chunk);
    });
    const runnerExit = new Promise<number>(resolve =>
      runner.on("exit", (code, signal) => resolve(code ?? (signal ? 137 : 1))),
    );
    const supervisorExit = new Promise<void>(resolve =>
      supervisor.on("exit", () => resolve()),
    );
    running.ended = (async () => {
      const code = await runnerExit;
      // As the wrapper: what the runner left behind dies, the supervisor
      // reads the rest of the pipe.
      try {
        process.kill(-(runner.pid as number), "SIGKILL");
      } catch {
        // Nothing left.
      }
      await supervisorExit;
      let reason = "error";
      try {
        reason = fs
          .readFileSync(path.join(dir, "supervisor.out"), "utf8")
          .trim();
      } catch {
        // The supervisor died without a word.
      }
      fs.writeFileSync(path.join(dir, "status"), `ended ${reason} ${code} 0\n`);
    })();
    this.sessions.set(id, running);
    const handle = { id };
    return { handle, outcome: await this.waitFor(handle, 1) };
  }

  async pull(handle: SessionHandle, seq: number): Promise<PullOutcome> {
    this.calls.push(`pull ${seq}`);
    const running = this.sessions.get(handle.id);
    if (!running || !fs.existsSync(running.dir)) {
      return { kind: "lost", reason: "the session was reaped" };
    }
    // The acknowledgement of seq - 1, as ackScript.
    fs.writeFileSync(path.join(running.dir, "heartbeat"), "");
    const now = new Date();
    fs.utimesSync(path.join(running.dir, "heartbeat"), now, now);
    for (const name of fs.readdirSync(path.join(running.dir, "batches"))) {
      const n = Number(name.replace(/\.jsonl$/, ""));
      if (name.endsWith(".jsonl") && n <= seq - 1) {
        fs.rmSync(path.join(running.dir, "batches", name));
      }
    }
    return this.waitFor(handle, seq);
  }

  private async waitFor(
    handle: SessionHandle,
    seq: number,
  ): Promise<PullOutcome> {
    const running = this.sessions.get(handle.id) as Running;
    const batch = path.join(running.dir, "batches", `${seq}.jsonl`);
    const status = path.join(running.dir, "status");
    for (let i = 0; i < 6_000; i++) {
      if (fs.existsSync(batch)) {
        return {
          kind: "batch",
          seq,
          result: parseBatch(fs.readFileSync(batch, "utf8"), 0, ""),
        };
      }
      if (fs.existsSync(status)) {
        if (fs.existsSync(batch)) continue;
        const [, reason, exitText] = fs
          .readFileSync(status, "utf8")
          .trim()
          .split(/\s+/);
        const tailFile = path.join(running.dir, "batches", `${seq}.tail`);
        return endedOutcome({
          seq,
          reason,
          exitCode: Number(exitText),
          tail: fs.existsSync(tailFile)
            ? fs.readFileSync(tailFile, "utf8")
            : null,
          stderr: running.stderr,
        });
      }
      await sleep(5);
    }
    throw new Error(`no batch ${seq} in 30 s`);
  }

  async close(handle: SessionHandle): Promise<void> {
    this.calls.push("close");
    const running = this.sessions.get(handle.id);
    if (!running) return;
    try {
      process.kill(-(running.runner.pid as number), "SIGKILL");
    } catch {
      // Already over.
    }
    await running.ended;
    fs.rmSync(running.dir, { recursive: true, force: true });
    this.sessions.delete(handle.id);
  }

  /** Sessions still open: a finished read must leave none. */
  open(): number {
    return this.sessions.size;
  }
}
