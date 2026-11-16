/**
 * The shell that isolates one connector run in a box that has real Unix
 * users (E2B). Pure strings, no I/O, so `sync-box.ts` runs exactly what the
 * Docker test (`run-isolation.docker.test.ts`) runs.
 *
 * Layout, all under a root-only parent (/var/lib is not world-writable, so
 * nothing a connector or a stray process does can pre-create or redirect it):
 *
 *   /var/lib/mako-connectors/runs           root:root 0711
 *     <runId>/                              root:<run group> 0750
 *       stage/                              root:root 0700   (the API writes inputs here)
 *       config.json, catalog.json, ...      <run user> 0400  (moved in at launch)
 *       home/                               <run user> 0700  (HOME, TMPDIR, cwd)
 *       out/                                root:root 0700
 *         out.jsonl                         stdout, opened by root
 *         out.bounded.jsonl                 the bounded copy the API reads
 *
 * Only the run's own group can enter the run directory, and every run has
 * its own random UID and GID, so no other run (concurrent or left over) can
 * even reach a path in it. Inputs never sit anywhere readable before they
 * are 0400 and owned by the run user: the API writes them into the root-only
 * `stage/`, and launch hands them over there and only then moves them in. The run user
 * cannot create, rename or replace anything root later opens: root opens
 * only `out/`, which the run user cannot even enter, and the connector
 * reaches its output file only through the stdout descriptor root hands it.
 */
import path from "node:path";

export const ISOLATED_ROOT = "/var/lib/mako-connectors";
export const ISOLATED_RUNS = path.posix.join(ISOLATED_ROOT, "runs");
export const ISOLATED_RUNTIME = path.posix.join(ISOLATED_ROOT, "runtime");

/** Rounds of `kill -9 -1` before a run's processes count as unkillable. */
export const KILL_ROUNDS = 100;
/** Exit code of the cleanup script when the run's processes would not die. */
export const CLEANUP_SURVIVORS_EXIT = 3;

const PATH_FOR_ROOT =
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/** Tools the setup and cleanup scripts need in the box. */
export const REQUIRED_TOOLS = [
  "runuser",
  "useradd",
  "userdel",
  "groupadd",
  "groupdel",
  "install",
  "stat",
  "find",
  "awk",
  "cat",
  "xargs",
  "mv",
  "usermod",
  "groupmod",
  "pwconv",
  "grpconv",
] as const;

export interface RunLayout {
  runId: string;
  user: string;
  uid: number;
  /** Random like the UID: sequential GIDs would be reused by the next run. */
  gid: number;
  /** root:<run group> 0750: the run's inputs, once handed over. */
  dir: string;
  /** root-only: where the API writes inputs before launch. */
  stage: string;
  /** The run user's own directory. */
  home: string;
  /** root-only. */
  out: string;
  outputFile: string;
  boundedFile: string;
}

export function runLayout(
  runId: string,
  user: string,
  uid: number,
  gid: number = uid,
): RunLayout {
  const dir = path.posix.join(ISOLATED_RUNS, runId);
  const out = path.posix.join(dir, "out");
  return {
    runId,
    user,
    uid,
    gid,
    dir,
    stage: path.posix.join(dir, "stage"),
    home: path.posix.join(dir, "home"),
    out,
    outputFile: path.posix.join(out, "out.jsonl"),
    boundedFile: path.posix.join(out, "out.bounded.jsonl"),
  };
}

const header = (l: RunLayout) => `${PATH_FOR_ROOT}
user=${shellQuote(l.user)}
uid=${l.uid}
gid=${l.gid}
R=${shellQuote(l.dir)}`;

/**
 * Root: list the tools a run needs that the box lacks, one per line.
 * Empty output means the box can isolate runs.
 */
export function preflightScript(): string {
  return `${PATH_FOR_ROOT}
for tool in ${REQUIRED_TOOLS.join(" ")}; do
  command -v "$tool" >/dev/null 2>&1 || echo "$tool"
done
true`;
}

/**
 * Root: lock every account and group whose password is empty, then prove
 * none is left. Fails closed. Part of every run's setup, not a per-box
 * cache: a box replaced under the same key comes fresh from the template.
 *
 * E2B's templates ship `root` and `user` with empty passwords, and Debian's
 * PAM stack allows them (`pam_unix.so nullok`). Without this, any run user
 * runs `su root` (or `su user`, then `sudo`) and owns the box. No sync box
 * workload logs in with a password: envd starts processes directly, and
 * `user`'s sudo rule is NOPASSWD, so locking changes nothing else. Costs one
 * awk per file when there is nothing to lock; usermod and groupmod take the
 * shadow lock, so concurrent runs retry them like useradd.
 */
export function hardenScript(): string {
  return `# A password kept in /etc/passwd or /etc/group itself (anything but "x",
# e.g. "node::" with no shadow line) bypasses the shadow files below. Move
# every such field into the shadow files first, so the lock below sees it.
n=0
while awk -F: '$2 != "x" { found = 1 } END { exit !found }' /etc/passwd; do
  pwconv 2>/dev/null && break
  n=$((n + 1)); if [ "$n" -ge 20 ]; then echo "could not move passwords out of /etc/passwd" >&2; exit 1; fi; sleep 0.2
done
n=0
while awk -F: '$2 != "x" { found = 1 } END { exit !found }' /etc/group; do
  grpconv 2>/dev/null && break
  n=$((n + 1)); if [ "$n" -ge 20 ]; then echo "could not move passwords out of /etc/group" >&2; exit 1; fi; sleep 0.2
done
for account in $(awk -F: '$2 == "" { print $1 }' /etc/shadow); do
  n=0
  until usermod -p '!' "$account" 2>/dev/null; do
    n=$((n + 1)); if [ "$n" -ge 20 ]; then echo "could not lock $account" >&2; exit 1; fi; sleep 0.2
  done
done
if [ -r /etc/gshadow ]; then
  for group in $(awk -F: '$2 == "" { print $1 }' /etc/gshadow); do
    n=0
    until groupmod -p '!' "$group" 2>/dev/null; do
      n=$((n + 1)); if [ "$n" -ge 20 ]; then echo "could not lock group $group" >&2; exit 1; fi; sleep 0.2
    done
  done
fi
left=$(awk -F: '$2 == "" { print $1 }' /etc/shadow; if [ -r /etc/gshadow ]; then awk -F: '$2 == "" { print "group:" $1 }' /etc/gshadow; fi; awk -F: '$2 != "x" { print "passwd:" $1 }' /etc/passwd; awk -F: '$2 != "x" { print "grouppw:" $1 }' /etc/group)
if [ -n "$left" ]; then echo "empty passwords left: $left" >&2; exit 1; fi`;
}

/** Root: create the run user and its directories. Fails closed. */
export function setupScript(l: RunLayout): string {
  return `set -eu
${header(l)}
missing=""
for tool in ${REQUIRED_TOOLS.join(" ")}; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then echo "missing tools:$missing" >&2; exit 1; fi
# No account a run user could su to: locked on every run, see hardenScript.
${hardenScript()}
install -d -o root -g root -m 0755 ${shellQuote(ISOLATED_ROOT)}
install -d -o root -g root -m 0711 ${shellQuote(ISOLATED_RUNS)}
# useradd and groupadd lock /etc/passwd and /etc/group; concurrent runs
# retry. -l keeps lastlog and faillog small with large random ids.
n=0
until err=$(groupadd -g "$gid" "$user" 2>&1); do
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then echo "$err" >&2; exit 1; fi
  sleep 0.2
done
n=0
until err=$(useradd -l -M -u "$uid" -g "$gid" -d "$R/home" -s /usr/sbin/nologin "$user" 2>&1); do
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then echo "$err" >&2; groupdel "$user" 2>/dev/null || true; exit 1; fi
  sleep 0.2
done
if ! { install -d -o root -g "$gid" -m 0750 "$R" \
    && install -d -o root -g root -m 0700 "$R/stage" \
    && install -d -o "$user" -g "$user" -m 0700 "$R/home" \
    && install -d -o root -g root -m 0700 "$R/out"; }; then
  rm -rf "$R"
  userdel "$user" 2>/dev/null || true
  groupdel "$user" 2>/dev/null || true
  exit 1
fi`;
}

/** Where the API writes an input before launch: the root-only stage. */
export function stagedPath(l: RunLayout, input: string): string {
  return path.posix.join(l.stage, path.posix.basename(input));
}

/**
 * Root: hand the staged inputs to the run user (0400, owned by it, while
 * still in the root-only stage), move them into the run directory, then
 * start `command` as the run user with stdout already open on a root-owned
 * file.
 *
 * `inputs` are the final paths in the run directory, as the connector's
 * arguments name them; each was written at `stagedPath`. `command` is a
 * shell-quoted argv, run by `runuser` without a shell.
 */
export function launchScript(
  l: RunLayout,
  inputs: string[],
  command: string,
): string {
  const staged = inputs.map(input => shellQuote(stagedPath(l, input)));
  const handOver = inputs.length
    ? `chown ${shellQuote(`${l.user}:${l.user}`)} ${staged.join(" ")} && chmod 0400 ${staged.join(" ")} && mv ${staged.join(" ")} ${shellQuote(l.dir)}/ && `
    : "";
  return `${handOver}cd ${shellQuote(l.home)} && runuser -u ${shellQuote(l.user)} -- env HOME=${shellQuote(l.home)} TMPDIR=${shellQuote(l.home)} ${command} > ${shellQuote(l.outputFile)}`;
}

/** Root: copy at most `maxBytes + 1` of the output and print its size. */
export function snapshotScript(l: RunLayout, maxBytes: number): string {
  const out = shellQuote(l.outputFile);
  const bounded = shellQuote(l.boundedFile);
  return `if test -f ${out}; then head -c ${maxBytes + 1} ${out} > ${bounded} && wc -c < ${bounded}; else echo missing; fi`;
}

/**
 * Root: end the run. Kills every thread of the run user until none is left,
 * removes its IPC objects, its directory and its files, then the user.
 *
 * Liveness is read per thread from /proc/<pid>/task/<tid>/status (the Uid
 * line), never from the owner of /proc/<pid>: a non-dumpable process shows
 * root as that owner, and a process whose main thread called pthread_exit
 * shows state Z while its other threads run. Processes die by `kill -9 -1`
 * as the run user, which signals all of them at once, so a process that
 * keeps forking cannot outrun a loop over pids. No procps needed.
 *
 * Fails closed. The run directory (with its credential) and the run's files
 * are removed whatever happens. If any thread survives KILL_ROUNDS rounds the
 * script exits CLEANUP_SURVIVORS_EXIT; any other leftover exits non-zero.
 * Either way the caller kills the box.
 */
export function cleanupScript(l: RunLayout): string {
  return `set -u
${header(l)}
# A live (not zombie, not dead) thread with the run's uid as any of its
# real, effective, saved or filesystem uids. State comes before Uid in
# status. The paths come from the shell's own glob and printf (a builtin),
# and xargs splits them, so no argv grows with the thread count. Reading no
# status at all counts as alive: a check that failed must not pass.
alive() {
  printf '%s\\n' /proc/[0-9]*/task/[0-9]*/status | xargs cat 2>/dev/null | awk -v n="$uid" '
    /^State:/ { st = $2; seen++ }
    /^Uid:/ { if (st != "Z" && st != "X") for (i = 2; i <= 5; i++) if ($i == n) { found = 1; exit } }
    END { exit !(found || seen == 0) }'
}
# One round always, before any check: a check that misses a thread must
# still have been preceded by a kill.
runuser -u "$user" -- kill -9 -1 2>/dev/null || true
survivors=0
n=0
while alive; do
  runuser -u "$user" -- kill -9 -1 2>/dev/null || true
  n=$((n + 1))
  if [ "$n" -ge ${KILL_ROUNDS} ]; then survivors=1; break; fi
  sleep 0.05
done
# SysV IPC the run created (and checked after, below). /proc/sysvipc has
# numeric owners; ipcs truncates long user names, so it cannot be trusted.
if command -v ipcrm >/dev/null 2>&1; then
  for kind in m:shm q:msg s:sem; do
    flag=\${kind%%:*}; table=/proc/sysvipc/\${kind#*:}
    [ -r "$table" ] || continue
    for id in $(awk -v n="$uid" 'NR == 1 { for (i = 1; i <= NF; i++) { if ($i == "uid") u = i; if ($i ~ /id$/ && !k) k = i }; next } u && $u == n { print $k }' "$table"); do
      # As the owner: root may lack CAP_IPC_OWNER in a container.
      runuser -u "$user" -- ipcrm -$flag "$id" 2>/dev/null || ipcrm -$flag "$id" 2>/dev/null || true
    done
  done
fi
# Always, survivors or not: the credential must not outlive the run.
rm -rf "$R"
for d in /tmp /var/tmp /dev/shm /run/lock /dev/mqueue; do
  [ -d "$d" ] && find "$d" -xdev -mindepth 1 -uid "$uid" -exec rm -rf {} + 2>/dev/null
done
if [ "$survivors" = 1 ]; then
  echo "threads of $user survived $n kill rounds" >&2
  exit ${CLEANUP_SURVIVORS_EXIT}
fi
if [ -e "$R" ]; then echo "run directory of $user survived" >&2; exit 1; fi
if find /tmp /var/tmp /dev/shm /run/lock /dev/mqueue -xdev -mindepth 1 -uid "$uid" 2>/dev/null | grep -q .; then
  echo "files of $user survived" >&2
  exit 1
fi
if [ -n "$(awk -v n="$uid" 'NR > 1 && $0 ~ (" " n " ")' /proc/sysvipc/shm /proc/sysvipc/msg /proc/sysvipc/sem 2>/dev/null)" ]; then
  echo "IPC objects of $user survived" >&2
  exit 1
fi
userdel "$user" || exit 1
groupdel "$user" 2>/dev/null || true`;
}
