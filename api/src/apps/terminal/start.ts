/**
 * Starting a terminal session in the sandbox — or adopting the dtach/tmux
 * session a previous API process left running.
 */
import { type WebSocket } from "ws";
import { loggers } from "../../logging";
import { type IAppProject } from "../../database/workspace-schema";
import { getSandboxProvider, type SandboxTerminal } from "../sandbox/provider";
import {
  afterTerminalSession,
  boxCtx,
  ensureBox,
  ensureWorktree,
} from "../worktree.service";
import type { ResizeMessage } from "./attach";
import {
  LiveTerminal,
  live,
  creating,
  dtachCapable,
  ORPHAN_GRACE_MS,
  remember,
  forward,
  existingWorktreeKey,
  sessionHistory,
  tmuxHistory,
  reattach,
} from "./sessions";

const logger = loggers.api("apps-terminal");

export async function startSession(
  ws: WebSocket,
  project: IAppProject,
  userId: string,
  termId: string,
  options: { initialCols: number; initialRows: number; fresh: boolean },
): Promise<void> {
  // Fast path first: if the shell is already running, attach to it and do no
  // repository work at all. Sessions are keyed per (worktree, terminal tab):
  // one sandbox, as many shells in it as the person opens.
  const knownKey = await existingWorktreeKey(project, userId).catch(() => null);
  const running = knownKey ? live.get(`${knownKey}:${termId}`) : undefined;

  // Say something before the slow part. The socket is already open by now, so
  // the client shows "open" while the server may spend the best part of a
  // minute creating a sandbox and syncing files into it — a blank pane that
  // claims to be connected, which is precisely the "terminal looks dead"
  // impression the rest of this file exists to avoid.
  if (!running && ws.readyState === ws.OPEN) {
    ws.send(
      Buffer.from(
        "\x1b[2m[connecting to the app's machine…]\x1b[0m\r\n",
        "utf8",
      ),
    );
  }

  let key: string;
  let session: LiveTerminal;
  let ranCreation = false;

  if (running) {
    key = `${knownKey!}:${termId}`;
    session = running;
    reattach(session, ws);
  } else {
    // Only the cold path pays for worktree setup.
    const handle = await ensureWorktree(project, userId);
    key = `${boxCtx(handle).sessionKey}:${termId}`;
    const existing = live.get(key);
    const inFlight = creating.get(key);
    if (existing) {
      session = existing;
      reattach(session, ws);
    } else if (inFlight) {
      session = await inFlight;
      reattach(session, ws);
    } else {
      let resolveCreated!: (t: LiveTerminal) => void;
      let rejectCreated!: (e: unknown) => void;
      const creation = new Promise<LiveTerminal>((res, rej) => {
        resolveCreated = res;
        rejectCreated = rej;
      });
      creation.catch(() => undefined); // observed via `creating`, not here
      creating.set(key, creation);
      ranCreation = true;
      try {
        const provider = getSandboxProvider();
        // Armed for dev windows: the first dtach attach emits a screen clear
        // we do not want (see onData). Declared here so onData can see it.
        let attachClearPending = termId.startsWith("dev-");
        const created: LiveTerminal = {
          terminal: undefined as unknown as SandboxTerminal,
          scrollback: [],
          scrollbackBytes: 0,
          sockets: new Set(),
          reaper: null,
          flush: () => undefined,
          tmux: false,
          repaint: false,
          ctx: null,
          tmuxSession: null,
          histFile: null,
          lastCols: 0,
          lastRows: 0,
        };
        // Output is BATCHED before it leaves the process.
        //
        // E2B delivers pty output almost byte by byte: 125KB of echo arrived as
        // 68,000 separate callbacks, which without this would be 68,000 WebSocket
        // frames for a single paste. Coalescing on a short timer makes that a few
        // hundred. VS Code batches terminal output for the same reason.
        //
        // Worth being precise about what this did NOT fix: the terminal freezing
        // on a large paste looked like client backpressure reaching the pty, and
        // it was not — it was the interactive shell (see BASHRC in
        // e2b-template.ts). Batching is a real saving on a chatty stream, not the
        // cure for that bug.
        let outbox: Buffer[] = [];
        let outboxBytes = 0;
        let flushTimer: NodeJS.Timeout | null = null;

        const flush = () => {
          flushTimer = null;
          if (outbox.length === 0) return;
          const chunk = outbox.length === 1 ? outbox[0] : Buffer.concat(outbox);
          outbox = [];
          outboxBytes = 0;
          remember(created, chunk);
          if (created.sockets.size === 0) {
            logger.info("Apps terminal output with no sockets", {
              termId,
              bytes: chunk.length,
            });
          }
          for (const socket of created.sockets) {
            // Skip a client that has stopped reading rather than buffering without
            // limit: one wedged tab must not take the server with it.
            if (
              socket.readyState === socket.OPEN &&
              socket.bufferedAmount < 8 * 1024 * 1024
            ) {
              socket.send(chunk);
            }
          }
        };

        // Hydrating here is what makes the terminal a real checkout: the
        // sandbox holds the repository, and nothing overwrites it afterwards —
        // so a `git checkout` typed in this shell survives.
        if (ws.readyState !== ws.OPEN) {
          throw new Error("client disconnected before the terminal opened");
        }
        const ctx = await ensureBox(handle, { lazyPull: true });
        // The client can vanish while the box boots (tab closed, page
        // reloaded, a dying page's last reconnect). Finishing the open
        // would leave a pty and a machine running for NOBODY — the shape
        // that re-created a recycled box from a page mid-teardown. Stop
        // here; a box ensureBox already made simply idles out.
        if (ws.readyState !== ws.OPEN) {
          throw new Error("client disconnected before the box was ready");
        }
        created.ctx = ctx;
        // The pty may be new while the SESSION is old (API restart, new
        // sandbox connection): prefill history now, before any live output,
        // so the client gets [history][live] in that order. A session that
        // does not exist yet has nothing to replay.
        const priorHistory = options.fresh
          ? null
          : ((await sessionHistory(ctx, `/tmp/mako-hist-${termId}.raw`, {
              dev: termId.startsWith("dev"),
            })) ?? (await tmuxHistory(ctx, `mako-${termId}`)));
        if (priorHistory) {
          if (termId.startsWith("dev-")) {
            // Dev windows are ring-replay sessions: put the history IN the
            // ring, where every attaching socket (including StrictMode's
            // second mount, which discards the first) replays it. A direct
            // send would reach only the first, often-doomed socket.
            remember(created, priorHistory);
          } else if (ws.readyState === ws.OPEN) {
            ws.send(priorHistory);
          }
        }
        // The app's folder can legitimately be absent — a box on a branch from
        // before the app existed, or a pull that refused to merge. A real
        // computer still gives you a shell; refusing to open one here bricked
        // the only tool that could fix the situation. Fall back to the repo
        // root and say so.
        const cwdProbe = await provider.exec(
          ctx,
          `test -d ${JSON.stringify(`/home/user/app/${handle.appRoot}`)} && echo yes || echo no`,
          { timeoutMs: 15_000 },
        );
        const appDirExists = cwdProbe.stdout.includes("yes");
        void Promise.resolve(getSandboxProvider().describe?.(ctx))
          .then(info => {
            created.bornOn = info?.sandboxId ?? null;
          })
          .catch(() => {
            created.bornOn = null;
          });
        created.terminal = await provider.openTerminal(ctx, {
          cwd: appDirExists ? handle.appRoot : ".",
          cols: options.initialCols,
          rows: options.initialRows,
          onExit: () => {
            // The shell is gone for good. Forget it, so the next connection
            // builds a fresh one instead of attaching to a corpse, and tell
            // whoever is watching — the client reconnects on close, and would
            // otherwise sit in front of a terminal that silently ignores every
            // keystroke. This is the difference between a sandbox expiring
            // overnight being invisible and it bricking the terminal until the
            // API restarts.
            if (live.get(key) === created) live.delete(key);
            if (created.reaper) clearTimeout(created.reaper);
            // A shell's pty ending is what `exit` MEANS: close the tab like
            // a real terminal app (client keys off the close code) instead
            // of respawning a shell nobody asked for. A dev window is the
            // opposite — it exists to watch a session that comes and goes,
            // so it reconnects into its waiting loop. Code 4000 = "session
            // over, do not reconnect"; 1012 = "shell lost, come back".
            const devWindow = termId.startsWith("dev-");
            void (async () => {
              // `exit` must close the tab reliably, so 4000 stays the
              // default; reconnect (1012) only on POSITIVE evidence the
              // machine itself died: the session key now resolves to a
              // different box than the one this pty was born on, or to no
              // box at all. A transient lookup failure counts as "unknown"
              // and keeps the close-the-tab behavior.
              let machineGone = false;
              if (!devWindow && created.bornOn) {
                try {
                  const info = await getSandboxProvider().describe?.(ctx);
                  machineGone = (info?.sandboxId ?? null) !== created.bornOn;
                } catch {
                  machineGone = false;
                }
              }
              const reconnect = devWindow || machineGone;
              const notice = devWindow
                ? "\r\n\x1b[2m[the dev server session ended]\x1b[0m\r\n"
                : machineGone
                  ? "\r\n\x1b[2m[the machine restarted — reconnecting…]\x1b[0m\r\n"
                  : "\r\n\x1b[2m[session ended]\x1b[0m\r\n";
              for (const socket of created.sockets) {
                if (socket.readyState === socket.OPEN) {
                  socket.send(Buffer.from(notice, "utf8"));
                  socket.close(reconnect ? 1012 : 4000, "session ended");
                }
              }
              created.sockets.clear();
            })();
          },
          onData: data => {
            let payload: Uint8Array | string = data;
            if (attachClearPending) {
              // dtach clears the client's screen when it attaches — which,
              // in a dev window, wipes the just-replayed session history.
              // Swallow that one clear (and only it); vite's own later
              // clears pass through untouched.
              const text = Buffer.from(data).toString("binary");
              // eslint-disable-next-line no-control-regex -- matching the terminal's own ESC bytes is the whole point
              const cleared = text.replace(/\x1b\[H\x1b\[[02]?J/, "\r\n");
              if (cleared !== text) {
                attachClearPending = false;
                payload = Buffer.from(cleared, "binary");
              }
            }
            outbox.push(Buffer.from(payload as Uint8Array));
            outboxBytes += payload.length;
            // Flush early on volume so a burst is not held back by the timer,
            // and otherwise coalesce a frame's worth of keystroke echo.
            if (outboxBytes >= 64 * 1024) {
              if (flushTimer) clearTimeout(flushTimer);
              flush();
            } else if (!flushTimer) {
              flushTimer = setTimeout(flush, 8);
            }
          },
        });
        created.flush = () => {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
        };

        // Hand the shell to tmux when the sandbox has it. This is what makes
        // sessions durable in the SANDBOX rather than in this process's `live`
        // map: an API restart loses the map, but the next attach runs the same
        // line and tmux `new -A` reattaches to the running session — scrollback,
        // running processes and all. Guarded, not exec'd blind: a sandbox
        // without tmux just keeps its plain bash, which is today's behavior.
        // `clear` hides the handoff line itself so the terminal opens clean.
        if (!appDirExists) {
          // Into the replay buffer, not the socket list — the caller's socket
          // attaches AFTER this block, and replay is what it reads first.
          remember(
            created,
            Buffer.from(
              `\r\n\x1b[33m[${handle.appRoot} is not in this checkout — opened at the repo root; try \x1b[1mgit pull\x1b[22m]\x1b[0m\r\n`,
              "utf8",
            ),
          );
        }
        // Session persistence WITHOUT a screen engine. dtach is a pure
        // socket relay around a pty: the shell's output reaches xterm.js as
        // the linear stream it is, so the browser terminal's own scrollback
        // and wheel physics work natively — no alternate screen, no
        // copy-mode, no scroll-event translation. (tmux was tried first: its
        // redraw engine and a browser terminal fight over scrolling — the
        // wheel either goes dead or turns erratic, and stripping smcup with
        // terminal-overrides no longer yields native scrollback on tmux 3.x,
        // whose engine scrolls with sequences emulators rightly keep out of
        // the scrollback buffer.) script(1) records the session to a file,
        // which is where reattach history comes from (sessionHistory). tmux
        // stays as the fallback for sandboxes without dtach, and remains the
        // right tool for the HEADLESS dev-server sessions.
        const tmuxSession = `mako-${termId}`;
        const histFile = `/tmp/mako-hist-${termId}.raw`;
        const dtachSock = `/tmp/mako-term-${termId}.sock`;
        // A `dev-<slug>` terminal is a WINDOW onto a session the dev-server
        // service owns (ensureDevServer starts it headlessly with dtach -n,
        // same socket/history naming). Attach-only: never start a shell at
        // this id — if the session is not up yet, wait for the socket and
        // attach the moment it appears. Ctrl-C then reaches vite like any
        // process in a terminal, colors flow because vite has a real pty,
        // and scrollback/prefill work exactly as in every other session.
        const isDevWindow = termId.startsWith("dev-");
        const conf =
          `# mako-terminal v2\\nset -g mouse off\\nset -g status off\\n` +
          `set -g history-limit 50000\\nset -g terminal-overrides ",*:smcup@:rmcup@"\\n`;
        if (isDevWindow) {
          // The handoff line is plumbing; without this it echoes as a wall
          // of shell into the dev window before the session content. Sent
          // as its own write so echo is off when the handoff is typed.
          await created.terminal
            .write(new TextEncoder().encode(" stty -echo 2>/dev/null\n"))
            .catch(() => undefined);
        }
        const handoff = isDevWindow
          ? // Not running yet: say so, then tail the recording (a cold Launch
            // tees npm install into it — live progress), and attach the
            // moment the session's socket appears. Running: attach directly.
            ` set +m; if [ ! -S ${dtachSock} ]; then printf '\\x1b[2m[waiting for the dev server]\\x1b[0m\\r\\n'; tail -n 0 -F ${histFile} 2>/dev/null & MAKO_TP=$!; while [ ! -S ${dtachSock} ]; do sleep 0.5; done; kill $MAKO_TP 2>/dev/null; fi; exec dtach -A ${dtachSock} -r winch true\n`
          : ` if command -v dtach >/dev/null && command -v script >/dev/null; then exec dtach -A ${dtachSock} -r winch script -qf -c 'bash -l' ${histFile}; fi; ` +
            `command -v tmux >/dev/null && { if [ ! -f "$HOME/.tmux.conf" ] || grep -q mako-terminal "$HOME/.tmux.conf"; then printf '${conf}' > "$HOME/.tmux.conf"; fi; ` +
            `tmux set -g mouse off 2>/dev/null; tmux set -g status off 2>/dev/null; ` +
            `exec tmux new -A -s ${tmuxSession}; }; clear\n`;
        await created.terminal
          .write(new TextEncoder().encode(handoff))
          .catch(() => undefined);
        // Which manager took over decides the reattach strategy. Probe once:
        // the dtach socket appears within a beat of the exec when dtach won.
        if (isDevWindow) {
          // A dev window is a plain ring-buffer session: dtach relays vite's
          // bytes with no terminal queries (the tmux-era reason to skip the
          // ring), so the ring replay is safe AND necessary — it is what
          // carries the waiting notice, the boot stream and the attach
          // output to sockets that connect after the pty was born
          // (StrictMode double-mounts eat one-shot output otherwise).
          created.tmux = false;
        } else {
          created.tmux = true;
          // Deterministic: the handoff execs dtach exactly when dtach AND
          // script exist, so ask for the capabilities, not the socket —
          // and only once per sandbox; capabilities are immutable while
          // the box lives.
          let capable = dtachCapable.get(ctx.sessionKey);
          if (capable === undefined) {
            const probe = await getSandboxProvider()
              .exec(
                ctx,
                `command -v dtach >/dev/null && command -v script >/dev/null && echo dtach || echo other`,
                { timeoutMs: 15_000 },
              )
              .catch(() => null);
            capable = probe?.stdout.includes("dtach") ?? false;
            if (probe) dtachCapable.set(ctx.sessionKey, capable);
          }
          if (capable) {
            created.histFile = histFile;
          } else {
            created.tmuxSession = tmuxSession;
          }
        }

        live.set(key, created);
        session = created;
        logger.info("Apps terminal started", {
          termId,
          projectId: project._id.toString(),
          appRoot: handle.appRoot,
        });
        resolveCreated(created);
      } catch (error) {
        rejectCreated(error);
        throw error;
      } finally {
        creating.delete(key);
      }
    }
  }

  const current = session;
  current.sockets.add(ws);
  if (ranCreation && !current.tmux) {
    // The creator's socket is attached AFTER the pty started talking, so
    // whatever the shell said in between lives only in the ring. Replay it —
    // for a dev window that is the waiting notice and the boot stream.
    reattach(current, ws);
  }

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const text = raw.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text) as ResizeMessage;
          if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
            current.lastCols = msg.cols;
            current.lastRows = msg.rows;
            if (current.repaint) {
              // tmux only repaints when the size CHANGES, and a reattaching
              // client usually reports exactly the size the pty already
              // has. One row down, then the real size: guaranteed change,
              // full redraw, invisible to the eye.
              current.repaint = false;
              const jiggle = msg.rows > 1 ? msg.rows - 1 : msg.rows + 1;
              void current.terminal
                .resize(msg.cols, jiggle)
                .then(() => current.terminal.resize(msg.cols, msg.rows))
                .catch(() => undefined);
              return;
            }
            void current.terminal
              .resize(msg.cols, msg.rows)
              .catch(() => undefined);
            return;
          }
        } catch {
          // Not a control message — fall through and type it.
        }
      }
      forward(current, Buffer.from(text, "utf8"));
      return;
    }
    forward(current, raw);
  });

  const detach = () => {
    current.sockets.delete(ws);
    if (current.sockets.size > 0 || current.reaper) return;
    // Nobody watching. Settle up first: a `git commit` typed in this shell is
    // sitting unpushed on a disposable machine, and a `git checkout` typed
    // here has moved the branch under the cached record. execInWorktree does
    // this after every command; a PTY has no "after", so the closest thing to
    // it is the last client leaving.
    void afterTerminalSession(project.workspaceId.toString(), userId);
    // Keep the shell for a while — a reload or a dropped connection should
    // not kill a running command — then reap it so an abandoned sandbox is
    // not held open forever.
    current.reaper = setTimeout(() => {
      live.delete(key);
      void current.terminal.close().catch(() => undefined);
      logger.info("Apps terminal reaped after no clients", { key });
    }, ORPHAN_GRACE_MS);
  };
  ws.on("close", detach);
  ws.on("error", detach);
}
