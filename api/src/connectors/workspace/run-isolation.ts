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
 *       config.json, catalog.json, ...      root:<run group> 0440
 *       home/                               <run user> 0700  (HOME, TMPDIR, cwd)
 *       out/                                root:root 0700
 *         out.jsonl                         stdout, opened by root
 *         out.bounded.jsonl                 the bounded copy the API reads
 *
 * The run user can read its inputs and write its home. It cannot create,
 * rename or replace anything root later opens: root opens only `out/`, which
 * the run user cannot even enter, and the connector reaches its output file
 * only through the stdout descriptor root hands it.
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

export interface RunLayout {
  runId: string;
  user: string;
  uid: number;
  /** root:<run group> 0750: the run's inputs. */
  dir: string;
  /** The run user's own directory. */
  home: string;
  /** root-only. */
  out: string;
  outputFile: string;
  boundedFile: string;
}

export function runLayout(runId: string, user: string, uid: number): RunLayout {
  const dir = path.posix.join(ISOLATED_RUNS, runId);
  const out = path.posix.join(dir, "out");
  return {
    runId,
    user,
    uid,
    dir,
    home: path.posix.join(dir, "home"),
    out,
    outputFile: path.posix.join(out, "out.jsonl"),
    boundedFile: path.posix.join(out, "out.bounded.jsonl"),
  };
}

const header = (l: RunLayout) => `${PATH_FOR_ROOT}
user=${shellQuote(l.user)}
uid=${l.uid}
R=${shellQuote(l.dir)}`;

/** Root: create the run user and its directories. Fails closed. */
export function setupScript(l: RunLayout): string {
  return `set -eu
${header(l)}
for tool in runuser useradd userdel stat find; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing $tool" >&2; exit 1; }
done
install -d -o root -g root -m 0755 ${shellQuote(ISOLATED_ROOT)}
install -d -o root -g root -m 0711 ${shellQuote(ISOLATED_RUNS)}
# useradd locks /etc/passwd; concurrent runs retry. -l keeps lastlog and
# faillog small with large random UIDs.
n=0
until err=$(useradd -l -M -U -u "$uid" -d "$R/home" -s /usr/sbin/nologin "$user" 2>&1); do
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then echo "$err" >&2; exit 1; fi
  sleep 0.2
done
if ! { install -d -o root -g "$user" -m 0750 "$R" \\
    && install -d -o "$user" -g "$user" -m 0700 "$R/home" \\
    && install -d -o root -g root -m 0700 "$R/out"; }; then
  rm -rf "$R"
  userdel "$user" 2>/dev/null || true
  exit 1
fi`;
}

/**
 * Root: hand the inputs to the run user read-only, then start `command` as
 * the run user with stdout already open on a root-owned file.
 *
 * `command` is a shell-quoted argv, run by `runuser` without a shell.
 */
export function launchScript(
  l: RunLayout,
  inputs: string[],
  command: string,
): string {
  const files = inputs.map(shellQuote).join(" ");
  const handOver = inputs.length
    ? `chown root:${shellQuote(l.user)} ${files} && chmod 0440 ${files} && `
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
 * Root: end the run. Kills every process of the run user until none is left,
 * removes its IPC objects and files, then the user.
 *
 * Needs no procps: processes are found through /proc and killed with
 * `kill -9 -1` as the run user, which signals all of them at once, so a
 * process that keeps forking cannot outrun a loop over pids. Exits
 * CLEANUP_SURVIVORS_EXIT if processes survive KILL_ROUNDS rounds, and
 * non-zero for any other failure; the box is then not trusted again.
 */
export function cleanupScript(l: RunLayout): string {
  return `set -u
${header(l)}
# A live (non-zombie) process of the run user. Zombies hold nothing and
# wait for their parent; they are not a reason to distrust the box.
alive() {
  for d in /proc/[0-9]*; do
    [ "$(stat -c %u "$d" 2>/dev/null)" = "$uid" ] || continue
    state=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -c1)
    [ -n "$state" ] && [ "$state" != Z ] && return 0
  done
  return 1
}
n=0
while alive; do
  runuser -u "$user" -- kill -9 -1 2>/dev/null || true
  n=$((n + 1))
  if [ "$n" -ge ${KILL_ROUNDS} ]; then
    echo "processes of $user survived $n kill rounds" >&2
    exit ${CLEANUP_SURVIVORS_EXIT}
  fi
  sleep 0.05
done
# SysV IPC the run created (and checked after, below). /proc/sysvipc has numeric owners; ipcs truncates
# long user names, so it cannot be trusted to match ours.
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
rm -rf "$R" || exit 1
for d in /tmp /var/tmp /dev/shm /run/lock /dev/mqueue; do
  [ -d "$d" ] && find "$d" -xdev -mindepth 1 -uid "$uid" -exec rm -rf {} + 2>/dev/null
done
if find /tmp /var/tmp /dev/shm /run/lock /dev/mqueue -xdev -mindepth 1 -uid "$uid" 2>/dev/null | grep -q .; then
  echo "files of $user survived" >&2
  exit 1
fi
if [ -n "$(awk -v n="$uid" 'NR > 1 && $0 ~ (" " n " ")' /proc/sysvipc/shm /proc/sysvipc/msg /proc/sysvipc/sem 2>/dev/null)" ]; then
  echo "IPC objects of $user survived" >&2
  exit 1
fi
userdel "$user" || exit 1`;
}
