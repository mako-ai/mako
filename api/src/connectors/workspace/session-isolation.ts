/**
 * The shell for a read SESSION: one connector process per entity read, in a
 * box with real Unix users (E2B). Pure strings, no I/O, so `session-read.ts`
 * runs exactly what the Docker test (`session-isolation.docker.test.ts`)
 * runs.
 *
 * A chunk run (run-isolation.ts `chunkScript`) creates a user, runs one
 * chunk and removes the user inside one command. A session keeps the user
 * and its process for the whole read, so the same steps are spread over
 * several commands:
 *
 *   start   setup (run-isolation.ts `setupScript`, so the empty-password lock
 *           and the per-run user are the chunk run's own), hand the inputs
 *           over, write the session's root-only scripts, start the wrapper
 *           detached, wait for batch 1.
 *   wait    acknowledge, then wait for batch N, or report how the session
 *           ended.
 *   ack     acknowledge batches up to N (they are applied) and beat.
 *   close   end the session now, clean up, remove everything.
 *
 * Layout, all root-owned under /var/lib (see run-isolation.ts):
 *
 *   /var/lib/mako-connectors/sessions/<id>/   root:root 0700
 *     batches/<seq>.jsonl                     complete batches the API reads
 *     batches/<seq>.part                      the batch being written
 *     batches/<seq>.tail                      what followed the last STATE
 *     run.sh, cleanup.sh                      root 0700, this file's text
 *     heartbeat                               written by every wait and ack
 *     acked                                   the highest acknowledged batch
 *     supervisor.pid                          the wrapper's pid, start time, boot id
 *     supervisor.out                          the reason the supervisor ended
 *     stderr.log                              the connector's, capped
 *     status                                  "ended <reason> <exit> <cleanup>"
 *   /var/lib/mako-connectors/runs/<id>/       the run directory, as a chunk's
 *   /var/lib/mako-connectors/tools/           the supervisor, by content hash
 *
 * The run user can reach none of it. It writes only to the pipe root reads,
 * and root opens no path the run user controls.
 *
 * No process of a session names its run directory or its id in argv, which
 * every user in the box can read in /proc/<pid>/cmdline. The API sends each
 * command in the environment (SandboxExecOptions.hideCommand). The wrapper
 * and the supervisor run in the session directory and take their paths
 * from their files and their environment. The connector runs in its home
 * and names its inputs relative to it. A process's cwd and environment are
 * readable by its own user only. On E2B, /proc is also mounted with
 * hidepid=invisible (run-isolation.ts `hardenScript`), so a run user sees no
 * other user's process at all.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  HIDEPID_CHECK,
  cleanupScript,
  incomingPath,
  ISOLATED_INCOMING,
  ISOLATED_ROOT,
  setupScript,
  shellQuote,
  stagedPath,
  type RunLayout,
} from "./run-isolation";
import { SESSION_SUPERVISOR_SOURCE } from "./session-supervisor";

export const ISOLATED_SESSIONS = path.posix.join(ISOLATED_ROOT, "sessions");
export const ISOLATED_TOOLS = path.posix.join(ISOLATED_ROOT, "tools");

/** The marker every session command prints last. */
export const SESSION_MARKER = "MAKO_SESSION";
/** Start exit codes, as chunkScript's. */
export const SESSION_SETUP_FAILED_EXIT = 97;
export const SESSION_INPUTS_MISSING_EXIT = 98;
/** Start refused: an earlier session in this box left something behind. */
export const SESSION_BOX_UNCLEAN_EXIT = 96;

/** The connector's stderr is kept up to this many bytes. */
const STDERR_CAP = 256 * 1024;

const PATH_FOR_ROOT =
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const SUPERVISOR_PATH = path.posix.join(
  ISOLATED_TOOLS,
  `session-supervisor-${createHash("sha256").update(SESSION_SUPERVISOR_SOURCE).digest("hex").slice(0, 16)}.mjs`,
);

export interface SessionLayout {
  /** The run user and run directory, as a chunk run's. */
  run: RunLayout;
  id: string;
  dir: string;
  batches: string;
}

/** A session's id is its run's id: one user, one run directory. */
export function sessionLayout(run: RunLayout): SessionLayout {
  const dir = sessionDir(run.runId);
  return {
    run,
    id: run.runId,
    dir,
    batches: path.posix.join(dir, "batches"),
  };
}

export function sessionDir(id: string): string {
  return path.posix.join(ISOLATED_SESSIONS, id);
}

/** A complete batch, as the API reads it. */
export function batchPath(id: string, seq: number): string {
  return path.posix.join(sessionDir(id), "batches", `${seq}.jsonl`);
}

/** What followed the last STATE (a TRACE error, logs). */
export function tailPath(id: string, seq: number): string {
  return path.posix.join(sessionDir(id), "batches", `${seq}.tail`);
}

export interface SessionLimits {
  /** Bytes per batch: MAX_CONNECTOR_PROTOCOL_BYTES. */
  maxBytes: number;
  /** Protocol lines per batch: MAX_CONNECTOR_PROTOCOL_MESSAGES. */
  maxMessages: number;
  /** Complete batches that may wait unacknowledged before the connector blocks. */
  buffer: number;
  /** No acknowledgement for this long ends the session (the API is gone). */
  idleMs: number;
  /** The session ends this long after it started, whatever happens. */
  maxAgeMs: number;
}

/** A heredoc whose delimiter cannot occur in `body`. */
function heredoc(target: string, body: string): string {
  let tag = `MAKO_EOF_${randomBytes(6).toString("hex")}`;
  while (body.includes(tag)) tag = `MAKO_EOF_${randomBytes(6).toString("hex")}`;
  return `cat > ${target} <<'${tag}'\n${body}\n${tag}`;
}

/**
 * Shell functions, bash builtins only, that read a process's start time and
 * process group from /proc/<pid>/stat. The start time (clock ticks since
 * boot) tells a process from a later one that reuses its pid.
 */
const PROC_FUNCTIONS = `# Every read below puts 2>/dev/null before its < redirect: bash applies
# redirects left to right, and a failed open would otherwise print its
# path on the script's stderr, which reaches the API's errors.
# Field 22 (start time) and 5 (process group) of /proc/<pid>/stat. The
# command name in parentheses may hold spaces: read after its last ")".
proc_field() {
  local field stat rest
  field=$2
  read -r stat 2>/dev/null < "/proc/$1/stat" || return 1
  rest=\${stat##*) }
  set -- $rest
  case "$field" in start) printf '%s' "\${20}" ;; pgid) printf '%s' "$3" ;; esac
}
proc_start() { proc_field "$1" start; }
proc_pgid() { proc_field "$1" pgid; }
boot_id() { local b; read -r b 2>/dev/null < /proc/sys/kernel/random/boot_id; printf '%s' "$b" | tr -cd 'a-f0-9'; }
# Kill the wrapper's process group, only while its pid is still the wrapper:
# the boot, pid and start time it recorded must match a live process. A
# wrapper that died left its pid free for reuse, and a box resumed from a
# filesystem-only snapshot booted again with every pid reused. Then its
# group's leftovers are killed one by one, and only those still running in
# this session's directory (the wrapper's cwd, which they inherited).
kill_wrapper_group() {
  local recorded pid start boot p cwd
  recorded=""
  read -r recorded 2>/dev/null < "$S/supervisor.pid"
  set -- $(printf '%s' "$recorded" | tr -cd '0-9a-f ')
  pid=\${1:-}; start=\${2:-}; boot=\${3:-}
  case "$pid$start" in ''|*[!0-9]*) return 0 ;; esac
  [ -n "$pid" ] && [ -n "$start" ] && [ -n "$boot" ] && [ "$pid" -gt 1 ] || return 0
  if [ "$boot" = "$(boot_id)" ] && [ "$(proc_start "$pid")" = "$start" ]; then
    kill -9 -- "-$pid" 2>/dev/null
    return 0
  fi
  for p in /proc/[0-9]*; do
    p=\${p#/proc/}
    [ "$(proc_pgid "$p")" = "$pid" ] || continue
    cwd=$(readlink "/proc/$p/cwd" 2>/dev/null)
    case "$cwd" in "$S"|"$S (deleted)") kill -9 "$p" 2>/dev/null ;; esac
  done
  return 0
}`;

/**
 * The session's wrapper, run detached as root: the connector as the run
 * user, its stdout a root-owned FIFO the supervisor reads; then the cleanup,
 * whatever happened; then the status line. A second, independent timer runs
 * the cleanup a minute after the deadline even if the supervisor hangs.
 *
 * The read ends when the connector's own process exits, not when its stdout
 * closes: a process it left running could hold the pipe open forever. So
 * the wrapper waits for that one process, then kills every other process of
 * the run user, and the supervisor reads what is left in the pipe.
 */
export function wrapperScript(input: {
  layout: SessionLayout;
  /**
   * The connector's shell-quoted argv, run by runuser without a shell, in
   * the run user's home. It names its inputs relative to that home
   * (`connectorInput`), never by their full path.
   */
  command: string;
  node: string;
  limits: SessionLimits;
}): string {
  const { layout: s, limits } = input;
  const l = s.run;
  const S = shellQuote(s.dir);
  const inputs = ["config.json", "catalog.json", "state.json"]
    .map(name => path.posix.join(l.dir, name))
    .join(",");
  const hardStop = Math.ceil(limits.maxAgeMs / 1000) + 60;
  return `#!/bin/bash
set -u
${PATH_FOR_ROOT}
S=${S}
# Every path below is relative to the session directory, or held in a
# variable: argv never names it (see the header).
cd "$S" || exit 1
# The pid, its start time and the boot: a reap or close kills this group
# only while all three still match (kill_wrapper_group).
read -r self < /proc/$$/stat
self=\${self##*) }
set -- $self
read -r boot < /proc/sys/kernel/random/boot_id
printf '%s %s %s\\n' "$$" "\${20}" "$(printf '%s' "$boot" | tr -cd 'a-f0-9')" > supervisor.pid.tmp && mv -f supervisor.pid.tmp supervisor.pid
set --
# The box's own clock: the API's may disagree with it.
deadline=$(( $(date +%s) * 1000 + ${limits.maxAgeMs} ))
# The independent backstop: the run user dies a minute after the deadline
# even if everything below hangs.
( exec </dev/null >/dev/null 2>&1; sleep ${hardStop}; bash cleanup.sh ) &
backstop=$!
mkfifo -m 0600 out
MAKO_SESSION_INPUTS=${shellQuote(inputs)} ${shellQuote(input.node)} ${shellQuote(SUPERVISOR_PATH)} --user ${shellQuote(l.user)} \\
  --max-bytes ${limits.maxBytes} --max-messages ${limits.maxMessages} \\
  --buffer ${limits.buffer} --idle-ms ${limits.idleMs} --deadline "$deadline" \\
  < out >/dev/null 2>supervisor.err &
supervisor=$!
# -p keeps this environment: the run user's passwd entry has no home
# (setupScript), so HOME and the rest come from here, not from argv.
( cd ${shellQuote(l.home)} && HOME=${shellQuote(l.home)} TMPDIR=${shellQuote(l.home)} USER=${shellQuote(l.user)} LOGNAME=${shellQuote(l.user)} exec runuser -p -u ${shellQuote(l.user)} -- ${input.command} ) \\
  < /dev/null > out 2> >(exec >/dev/null; head -c ${STDERR_CAP} > stderr.log; cat > /dev/null) &
connector=$!
wait "$connector"
code=$?
# Whatever the connector left running holds the pipe open: end it, so the
# supervisor reads the rest and stops.
runuser -u ${shellQuote(l.user)} -- kill -9 -1 2>/dev/null
wait "$supervisor"
bash cleanup.sh >/dev/null 2>cleanup.err
cleanup=$?
kill "$backstop" 2>/dev/null
reason=$(head -c 64 supervisor.out 2>/dev/null | tr -cd 'a-z-')
printf 'ended %s %s %s\\n' "\${reason:-error}" "$code" "$cleanup" > status.tmp && mv -f status.tmp status
# Nobody is reading an abandoned session: drop its data, keep the status
# only when the cleanup failed, for the next start to report.
if [ "\${reason:-}" = abandoned ]; then
  if [ "$cleanup" = 0 ]; then rm -rf "$S"; else rm -rf batches; fi
fi`;
}

/**
 * An input as the connector names it: relative to its home, the run
 * directory's `home/`, so its argv never holds the run directory.
 */
export function connectorInput(file: string): string {
  return path.posix.join("..", path.posix.basename(file));
}

/**
 * Root: end every session in this box that nobody is reading.
 *
 * - Ended, and not acknowledged for `idleMs`: its leftover batches go.
 * - Not ended, and not acknowledged for twice `idleMs`: its supervisor
 *   should have ended it at `idleMs` and did not (killed, hung). Its process
 *   group dies and its cleanup runs here.
 *
 * Prints `MAKO_SESSION box-unclean <ids>` and exits SESSION_BOX_UNCLEAN_EXIT
 * when a cleanup failed, now or in a session that ended earlier. The API
 * then kills the box.
 */
export function reapScript(idleMs: number): string {
  const idle = Math.max(1, Math.ceil(idleMs / 1000));
  return `${PATH_FOR_ROOT}
${PROC_FUNCTIONS}
unclean=""
now=$(date +%s)
for S in ${shellQuote(ISOLATED_SESSIONS)}/*; do
  [ -d "$S" ] || continue
  # A session being created has no heartbeat for a moment: its directory's
  # own time stands in, so a concurrent start never reaps it.
  beat=$(cd "$S" 2>/dev/null && { stat -c %Y heartbeat 2>/dev/null || stat -c %Y . 2>/dev/null; } || echo 0)
  age=$((now - beat))
  if [ -f "$S/status" ]; then
    cleanup=$(awk '{ print $4 }' 2>/dev/null < "$S/status")
    if [ "$cleanup" != 0 ]; then unclean="$unclean \${S##*/}"; rm -rf "$S"; continue; fi
    [ "$age" -gt ${idle} ] && rm -rf "$S"
    continue
  fi
  if [ "$age" -gt ${idle * 2} ] && [ -f "$S/cleanup.sh" ]; then
    kill_wrapper_group
    # Only a user this session created: its cleanup acts on its UID.
    owner=$(head -c 64 2>/dev/null < "$S/user" | tr -cd 'a-z0-9')
    if [ -n "$owner" ] && id -u "$owner" >/dev/null 2>&1 && ! (cd "$S" && bash cleanup.sh) >/dev/null 2>&1; then unclean="$unclean \${S##*/}"; fi
    rm -rf "$S" ${shellQuote(ISOLATED_INCOMING)}/"\${S##*/}"
  fi
done
if [ -n "$unclean" ]; then echo "${SESSION_MARKER} box-unclean$unclean"; exit ${SESSION_BOX_UNCLEAN_EXIT}; fi`;
}

/**
 * Root: acknowledge batches up to `ackUpTo` (0: none), beat, then wait up to
 * `waitMs` for batch `seq`. Prints one marker line:
 *
 *   MAKO_SESSION ready <seq> <bytes>
 *   MAKO_SESSION ended <reason> <exit> <cleanup> <tail bytes|none>
 *   MAKO_SESSION waiting
 *   MAKO_SESSION gone
 *   MAKO_SESSION acked      (batch <seq> was acknowledged by another attempt)
 *
 * On `ended` the connector's stderr tail goes to stderr.
 */
export function waitScript(
  id: string,
  seq: number,
  ackUpTo: number,
  waitMs: number,
): string {
  const rounds = Math.max(1, Math.ceil(waitMs / 50));
  return `${PATH_FOR_ROOT}
S=${shellQuote(sessionDir(id))}
seq=${seq}
${ackBody(ackUpTo)}
i=0
while :; do
  if [ -f "$S/batches/$seq.jsonl" ]; then echo "${SESSION_MARKER} ready $seq $(wc -c < "$S/batches/$seq.jsonl")"; exit 0; fi
  if [ ! -d "$S" ]; then echo "${SESSION_MARKER} gone"; exit 0; fi
  # Another attempt already took this batch and acknowledged it.
  acked=$(head -c 20 2>/dev/null < "$S/acked" | tr -cd 0-9)
  if [ "\${acked:-0}" -ge "$seq" ]; then echo "${SESSION_MARKER} acked"; exit 0; fi
  if [ -f "$S/status" ]; then
    # The batch is renamed before the status is written: look once more.
    if [ -f "$S/batches/$seq.jsonl" ]; then echo "${SESSION_MARKER} ready $seq $(wc -c < "$S/batches/$seq.jsonl")"; exit 0; fi
    rest=none
    [ -f "$S/batches/$seq.tail" ] && rest=$(wc -c < "$S/batches/$seq.tail")
    [ -f "$S/stderr.log" ] && tail -c 2000 < "$S/stderr.log" >&2
    echo "${SESSION_MARKER} $(head -c 200 < "$S/status" | tr -cd 'a-z0-9 -') $rest"
    exit 0
  fi
  i=$((i + 1))
  if [ "$i" -ge ${rounds} ]; then echo "${SESSION_MARKER} waiting"; exit 0; fi
  sleep 0.05
done`;
}

/** Shell that beats and deletes batches up to `ackUpTo`, in `$S`. */
function ackBody(ackUpTo: number): string {
  const upTo = Math.max(0, Math.floor(ackUpTo));
  return `if [ -d "$S" ]; then (
  cd "$S" || exit 0
  # A write, not touch: a redirect names no path in argv.
  printf x > heartbeat
  acked=$(head -c 20 2>/dev/null < acked | tr -cd 0-9)
  if [ ${upTo} -gt "\${acked:-0}" ]; then printf '%s' ${upTo} > acked.tmp && mv -f acked.tmp acked; fi
  for f in batches/*.jsonl; do
    [ -f "$f" ] || continue
    n=\${f##*/}; n=\${n%.jsonl}
    case "$n" in ''|*[!0-9]*) continue ;; esac
    [ "$n" -le ${upTo} ] && rm -f "$f"
  done
)
fi`;
}

/** Root: acknowledge batches up to `ackUpTo` and beat. Off the critical path. */
export function ackScript(id: string, ackUpTo: number): string {
  return `S=${shellQuote(sessionDir(id))}
${ackBody(ackUpTo)}
true`;
}

/**
 * Root: end the session now. A session still running is cleaned up here
 * (its connector dies, its user and run directory go); one that ended was
 * cleaned up by its wrapper. Then its directory and inbox go. Prints
 * `MAKO_SESSION closed <cleanup exit>`, non-zero when anything of the run
 * survived.
 */
export function closeScript(id: string): string {
  const S = shellQuote(sessionDir(id));
  return `${PATH_FOR_ROOT}
${PROC_FUNCTIONS}
S=${S}
code=0
if [ -d "$S" ]; then
  if [ ! -f "$S/status" ] && [ -f "$S/cleanup.sh" ]; then
    # Drop the waiting batches first: a supervisor holding the connector
    # back must read on to the end of the pipe. Then kill the connector;
    # its wrapper runs the cleanup, once, and writes the status.
    (cd "$S" && rm -f batches/*.jsonl)
    user=$(head -c 64 2>/dev/null < "$S/user" | tr -cd 'a-z0-9')
    [ -n "$user" ] && runuser -u "$user" -- kill -9 -1 2>/dev/null
    i=0
    while [ ! -f "$S/status" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
    if [ ! -f "$S/status" ]; then
      # No wrapper to do it: stop whatever is left of it, clean up here.
      kill_wrapper_group
      if [ -n "$user" ] && id -u "$user" >/dev/null 2>&1; then
        (cd "$S" && bash cleanup.sh) >/dev/null 2>&1
        code=$?
      fi
    fi
  fi
  if [ -f "$S/status" ]; then
    wrapped=$(awk '{ print $4 }' 2>/dev/null < "$S/status")
    [ "$wrapped" = 0 ] || code=\${wrapped:-1}
  fi
  rm -rf "$S"
fi
rm -rf ${shellQuote(ISOLATED_INCOMING)}/${shellQuote(path.posix.basename(sessionDir(id)))}
if [ -e "$S" ]; then echo "session directory survived" >&2; code=1; fi
echo "${SESSION_MARKER} closed $code"`;
}

/**
 * Root: start a session. Reaps first (a box with a failed cleanup refuses),
 * creates the run user with the chunk run's own `setupScript`, moves the
 * inputs from the root-only inbox into the run directory as the run user's
 * 0400 files, writes the session's scripts and the supervisor, starts the
 * wrapper detached and waits up to `waitMs` for batch 1 (waitScript's
 * markers). `inputs` are the final paths in the run directory, as the
 * connector's arguments name them.
 */
export function startScript(input: {
  layout: SessionLayout;
  inputs: string[];
  command: string;
  node: string;
  limits: SessionLimits;
  waitMs: number;
}): string {
  const { layout: s } = input;
  const l = s.run;
  const inbox = shellQuote(path.posix.join(ISOLATED_INCOMING, l.runId));
  const S = shellQuote(s.dir);
  const moves = input.inputs
    .map(
      file =>
        `mv -- ${shellQuote(incomingPath(l.runId, path.posix.basename(file)))} ${shellQuote(stagedPath(l, file))} || staged=0`,
    )
    .join("\n");
  const staged = input.inputs.map(file => shellQuote(stagedPath(l, file)));
  const handOver = staged.length
    ? `chown ${shellQuote(`${l.user}:${l.user}`)} ${staged.join(" ")} && chmod 0400 ${staged.join(" ")} && mv ${staged.join(" ")} ${shellQuote(l.dir)}/`
    : "true";
  const supervisor = shellQuote(SUPERVISOR_PATH);
  return `${PATH_FOR_ROOT}
install -d -o root -g root -m 0755 ${shellQuote(ISOLATED_ROOT)}
install -d -o root -g root -m 0700 ${shellQuote(ISOLATED_SESSIONS)}
${reapScript(input.limits.idleMs)}
S=${S}
install -d -o root -g root -m 0700 "$S" "$S/batches"
# Beat first: a concurrent start's reap must never take this for abandoned.
printf x > "$S/heartbeat"
printf '%s' ${shellQuote(l.user)} > "$S/user"
# The cleanup exists before the user does: whatever cuts this start short,
# a close or a reap can remove what it created.
${heredoc(`"$S/cleanup.sh"`, cleanupScript(l))}
(cd "$S" && chmod 0700 cleanup.sh)
if ! (
${setupScript(l)}
); then
  # setupScript removed what it made. Never the cleanup here: on a UID
  # collision it would act on the other run's UID.
  rm -rf ${inbox} "$S"
  echo "${SESSION_MARKER} setup-failed"
  exit ${SESSION_SETUP_FAILED_EXIT}
fi
# Without hidepid every user reads every argv: say so, once per start.
${HIDEPID_CHECK} || echo "${SESSION_MARKER} hidepid-off"
staged=1
${moves}
rm -rf ${inbox}
if [ "$staged" != 1 ] || ! { ${handOver}; }; then
  (cd "$S" && bash cleanup.sh) >/dev/null 2>&1
  rm -rf "$S"
  echo "${SESSION_MARKER} inputs-missing"
  exit ${SESSION_INPUTS_MISSING_EXIT}
fi
if [ ! -f ${supervisor} ]; then
  install -d -o root -g root -m 0755 ${shellQuote(ISOLATED_TOOLS)}
  ${heredoc(`${supervisor}.$$`, SESSION_SUPERVISOR_SOURCE)}
  chmod 0644 ${supervisor}.$$ && mv -f ${supervisor}.$$ ${supervisor}
fi
${heredoc(
  `"$S/run.sh"`,
  wrapperScript({
    layout: s,
    command: input.command,
    node: input.node,
    limits: input.limits,
  }),
)}
(cd "$S" && chmod 0700 run.sh)
printf x > "$S/heartbeat"
# From its own directory, so its argv is "bash run.sh" and names nothing.
( cd "$S" && exec setsid nohup bash run.sh </dev/null >/dev/null 2>&1 ) &
${waitScript(s.id, 1, 0, input.waitMs)}`;
}
