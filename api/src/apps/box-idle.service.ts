/**
 * The app-box idle policy: pause after N idle minutes, delete after D unused
 * days, and report what the fleet costs.
 *
 * Why this exists (16 Nov 2026): 19 of 20 E2B slots were taken, 15 of them
 * by app boxes at 0–3% CPU, several up 40–57 minutes, and 89 paused boxes
 * sat on the account with a median start 23 days back. E2B's own idle
 * timeout never fired for an open tab, because the tab's polls exec into the
 * box and every exec refreshes the timeout (see box-activity.ts). Paused
 * boxes were never deleted by anyone.
 *
 * Two sweeps, both Inngest crons (inngest/functions/apps-box-idle.ts):
 *
 * - sweepIdleBoxes, every 2 minutes (APPS_BOX_IDLE_SWEEP, on by default):
 *   pause (with memory) each running person's box whose last REAL use is N
 *   minutes old, unless a workflow run or a terminal command is still going
 *   in it. Logs running/paused counts and box-seconds per workspace.
 * - The reaper, hourly (APPS_BOX_REAPER, OFF by default): delete a person's
 *   session whose boxes are all paused and whose last real use is D days
 *   old. Each box is settled by its own id first (box/rescue-commit.ts):
 *   uncommitted work goes to a `mako-presave/...` branch, never to main or
 *   the session branch. A box that cannot be settled safely is kept.
 *
 * Neither ever touches: the publish actor's box or any non-person actor,
 * connector boxes (key filter in e2b-fleet.ts), or a session this database
 * does not know (dev machines and previews share the E2B account).
 *
 * "Use" is the activity record only. A box's E2B start time is NOT use: a
 * resume restarts it, and counting it would let a poll-driven resume keep a
 * box alive (the resume-and-pause loop). Sessions with no record count from
 * the day activity tracking started (`trackingSince`).
 */
import mongoose from "mongoose";
import { loggers } from "../logging";
import {
  getBoxActivity,
  parseSessionKey,
  type BoxActivity,
} from "./box-activity";
import { markBoxOffline } from "./box-state.service";
import { rescueCommit, type RescueResult } from "./box/rescue-commit";
import { appsGitOriginUrl } from "./config";
import { mintGitToken } from "./git-token.service";
import {
  killAppBox,
  listAppBoxes,
  openAppBoxById,
  pauseAppBox,
  type AppBoxInfo,
} from "./sandbox/e2b-fleet";
import { noteSessionPaused } from "./sandbox/e2b-provider";
import { getSandboxProvider } from "./sandbox/provider";
import { forgetTerminalCaches } from "./terminal/sessions";
import { forgetBoxCaches, resolveActorIdentity } from "./worktree/box-session";
import { isUserActor } from "./worktree/worktrees";

const logger = loggers.api("apps-box-idle");

/** How often the pause sweep runs; also the box-seconds each tick bills. */
export const IDLE_SWEEP_INTERVAL_SECONDS = 120;

/** Where the working copy lives in an app box (e2b-provider REMOTE_ROOT). */
const BOX_ROOT = "/home/user/app";

export interface BoxIdleConfig {
  /** Pause sweep. Off only with `APPS_BOX_IDLE_SWEEP=off`. */
  enabled: boolean;
  /** Deletion. On only with `APPS_BOX_REAPER=on`. */
  reaperEnabled: boolean;
  /** Pause a running box this long after its last real use. */
  idleMs: number;
  /** Delete a paused session this long after its last real use. */
  pausedRetentionMs: number;
  /** At most this many sessions deleted per hourly run. */
  reapBatch: number;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Knobs, all optional:
 *   APPS_BOX_IDLE_MINUTES           default 10
 *   APPS_BOX_PAUSED_RETENTION_DAYS  default 14
 *   APPS_BOX_REAP_BATCH             default 10
 *   APPS_BOX_IDLE_SWEEP=off         disables the pause sweep
 *   APPS_BOX_REAPER=on              enables deletion (off by default)
 */
export function boxIdleConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoxIdleConfig {
  return {
    enabled: env.APPS_BOX_IDLE_SWEEP !== "off",
    reaperEnabled: env.APPS_BOX_REAPER === "on",
    idleMs: positive(env.APPS_BOX_IDLE_MINUTES, 10) * 60_000,
    pausedRetentionMs:
      positive(env.APPS_BOX_PAUSED_RETENTION_DAYS, 14) * 24 * 3_600_000,
    reapBatch: Math.floor(positive(env.APPS_BOX_REAP_BATCH, 10)),
  };
}

/** A person's own session box: `<ws>:<24-hex userId>`. Not publish, not api-key. */
export function isPersonSession(sessionKey: string): boolean {
  const parts = parseSessionKey(sessionKey);
  return !!parts && isUserActor(parts.userId);
}

/** Last real use: the activity record, else the day tracking started. */
export function lastUseOf(
  activity: BoxActivity | undefined,
  trackingSince: Date,
): number {
  return activity?.lastActivityAt?.getTime() ?? trackingSince.getTime();
}

/** When a running session may be paused: N idle minutes, or after its hold. */
export function idleDeadline(
  activity: BoxActivity | undefined,
  trackingSince: Date,
  idleMs: number,
): number {
  return Math.max(
    lastUseOf(activity, trackingSince) + idleMs,
    activity?.activeUntil?.getTime() ?? 0,
  );
}

function groupBySession(boxes: AppBoxInfo[]): Map<string, AppBoxInfo[]> {
  const out = new Map<string, AppBoxInfo[]>();
  for (const box of boxes) {
    const list = out.get(box.sessionKey) ?? [];
    list.push(box);
    out.set(box.sessionKey, list);
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

export interface WorkspaceBoxUsage {
  workspaceId: string;
  running: number;
  paused: number;
  /** Running boxes × sweep interval: sum these over time for box-seconds. */
  boxSeconds: number;
  /** Same, in vCPU-seconds (what E2B bills). */
  vcpuSeconds: number;
  /** Sum of the running boxes' uptime right now. */
  uptimeSeconds: number;
}

export function usageByWorkspace(
  boxes: AppBoxInfo[],
  now: number,
  intervalSeconds = IDLE_SWEEP_INTERVAL_SECONDS,
): WorkspaceBoxUsage[] {
  const out = new Map<string, WorkspaceBoxUsage>();
  for (const box of boxes) {
    const workspaceId =
      parseSessionKey(box.sessionKey)?.workspaceId ?? "unknown";
    const row = out.get(workspaceId) ?? {
      workspaceId,
      running: 0,
      paused: 0,
      boxSeconds: 0,
      vcpuSeconds: 0,
      uptimeSeconds: 0,
    };
    if (box.state === "running") {
      row.running += 1;
      row.boxSeconds += intervalSeconds;
      row.vcpuSeconds += intervalSeconds * (box.cpuCount || 1);
      row.uptimeSeconds += Math.max(
        0,
        Math.round((now - box.startedAt.getTime()) / 1000),
      );
    } else {
      row.paused += 1;
    }
    out.set(workspaceId, row);
  }
  return [...out.values()];
}

// --------------------------------------------------------------------------
// Pause sweep
// --------------------------------------------------------------------------

export interface SweepDeps {
  listBoxes(): Promise<AppBoxInfo[]>;
  getActivity(sessionKeys: string[]): Promise<Map<string, BoxActivity>>;
  /** When activity tracking started; the sweep records it on its first run. */
  trackingSince(): Promise<Date>;
  /** Work still going in this box: a workflow run or a terminal command. */
  runningWork(box: AppBoxInfo): Promise<string | null>;
  /** Tell open tabs the box is asleep BEFORE pausing it (see below). */
  announceAsleep(sessionKey: string): Promise<void>;
  pause(sandboxId: string): Promise<boolean>;
  now(): number;
}

export interface SweepResult {
  running: number;
  paused: number;
  pausedNow: Array<{
    sessionKey: string;
    sandboxId: string;
    idleMinutes: number;
  }>;
  kept: Array<{ sessionKey: string; reason: string }>;
  usage: WorkspaceBoxUsage[];
}

export async function sweepIdleBoxes(
  deps: SweepDeps,
  config: BoxIdleConfig = boxIdleConfig(),
): Promise<SweepResult> {
  const now = deps.now();
  const boxes = await deps.listBoxes();
  const since = await deps.trackingSince();
  const usage = usageByWorkspace(boxes, now);
  const running = boxes.filter(b => b.state === "running");
  const result: SweepResult = {
    running: running.length,
    paused: boxes.length - running.length,
    pausedNow: [],
    kept: [],
    usage,
  };
  const sessions = groupBySession(
    running.filter(b => isPersonSession(b.sessionKey)),
  );
  if (sessions.size === 0) return result;

  const activity = await deps.getActivity([...sessions.keys()]);
  for (const [sessionKey, list] of sessions) {
    const act = activity.get(sessionKey);
    if (!act?.known) {
      result.kept.push({
        sessionKey,
        reason: "not a session of this database",
      });
      continue;
    }
    if (now < idleDeadline(act, since, config.idleMs)) continue;

    let busy: string | null = null;
    try {
      for (const box of list) {
        busy = await deps.runningWork(box);
        if (busy) break;
      }
    } catch (error) {
      // Cannot tell: keep it running this tick rather than pause work.
      busy = `work probe failed: ${message(error)}`;
    }
    if (busy) {
      result.kept.push({ sessionKey, reason: busy });
      continue;
    }

    // Re-read just this session: the probe took seconds, and someone may
    // have typed or saved meanwhile.
    const fresh = (await deps.getActivity([sessionKey])).get(sessionKey);
    if (deps.now() < idleDeadline(fresh, since, config.idleMs)) {
      result.kept.push({ sessionKey, reason: "used during the sweep" });
      continue;
    }

    // Offline first, pause second. Pausing drops every pty, and a terminal
    // that sees its socket close while the box still reads "online"
    // reconnects within a second through ensureBox, which resumes the box
    // that was just paused. Announced first, it shows "off" and waits.
    await deps.announceAsleep(sessionKey).catch(() => undefined);
    const idleMinutes = Math.round((now - lastUseOf(fresh, since)) / 60_000);
    for (const box of list) {
      try {
        await deps.pause(box.sandboxId);
        result.pausedNow.push({
          sessionKey,
          sandboxId: box.sandboxId,
          idleMinutes,
        });
      } catch (error) {
        result.kept.push({
          sessionKey,
          reason: `pause failed: ${message(error)}`,
        });
      }
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// Paused-box reaper
// --------------------------------------------------------------------------

export interface ReapCandidate {
  sessionKey: string;
  sandboxIds: string[];
  /** Last real use (ms) at planning time. */
  lastUse: number;
}

export interface ReapPlan {
  due: ReapCandidate[];
  skipped: Array<{ sessionKey: string; reason: string }>;
}

export interface ReapDeps {
  listBoxes(): Promise<AppBoxInfo[]>;
  getActivity(sessionKeys: string[]): Promise<Map<string, BoxActivity>>;
  /** When tracking started; null = never recorded, so no grace has run. */
  trackingSince(): Promise<Date | null>;
  /** Settle ONE box by its id: connect-only, never create, never kill. */
  settle(sessionKey: string, sandboxId: string): Promise<RescueResult>;
  /** Put a box back to sleep after a settle that kept it. */
  pause(sandboxId: string): Promise<boolean>;
  kill(sandboxId: string): Promise<unknown>;
  /** Drop what the API believed about the session and tell open tabs. */
  forget(sessionKey: string): Promise<void>;
  now(): number;
}

/**
 * Which sessions are due. Grace rule: a session is due only when its
 * recorded last use is D days old. With no record, only once tracking has
 * run D days. E2B start times never count.
 */
export async function planReap(
  deps: Pick<ReapDeps, "listBoxes" | "getActivity" | "trackingSince" | "now">,
  config: BoxIdleConfig,
): Promise<ReapPlan> {
  const now = deps.now();
  const since = await deps.trackingSince();
  const sessions = groupBySession(await deps.listBoxes());
  const plan: ReapPlan = { due: [], skipped: [] };
  const people = [...sessions.keys()].filter(isPersonSession);
  const activity = await deps.getActivity(people);
  for (const sessionKey of people) {
    const list = sessions.get(sessionKey) ?? [];
    // Any running box means the session is in use (or about to be paused).
    if (list.some(b => b.state !== "paused")) continue;
    const act = activity.get(sessionKey);
    if (!act?.known) {
      plan.skipped.push({
        sessionKey,
        reason: "not a session of this database",
      });
      continue;
    }
    const lastUse = act.lastActivityAt?.getTime() ?? since?.getTime() ?? null;
    if (lastUse === null || now - lastUse < config.pausedRetentionMs) continue;
    plan.due.push({
      sessionKey,
      sandboxIds: list.map(b => b.sandboxId),
      lastUse,
    });
  }
  // Oldest first, so a backlog drains in age order across runs.
  plan.due.sort((a, b) => a.lastUse - b.lastUse);
  plan.due = plan.due.slice(0, config.reapBatch);
  return plan;
}

export interface ReapOutcome {
  sessionKey: string;
  action: "deleted" | "kept";
  reason?: string;
  rescues: Array<{ sandboxId: string; result: RescueResult }>;
  killFailures: string[];
}

/** Settle every box of one session by id, then kill them. Never throws. */
export async function reapSession(
  deps: ReapDeps,
  candidate: ReapCandidate,
): Promise<ReapOutcome> {
  const { sessionKey } = candidate;
  const outcome: ReapOutcome = {
    sessionKey,
    action: "kept",
    rescues: [],
    killFailures: [],
  };
  const fresh = (await deps.getActivity([sessionKey])).get(sessionKey);
  if ((fresh?.lastActivityAt?.getTime() ?? 0) > candidate.lastUse) {
    outcome.reason = "used since planning";
    return outcome;
  }
  const resumed: string[] = [];
  for (const sandboxId of candidate.sandboxIds) {
    let result: RescueResult;
    try {
      resumed.push(sandboxId);
      result = await deps.settle(sessionKey, sandboxId);
    } catch (error) {
      result = {
        status: "manual",
        reason: `settle failed: ${message(error)}`,
        excluded: [],
        ignored: [],
      };
    }
    outcome.rescues.push({ sandboxId, result });
    if (result.status === "manual") {
      outcome.reason = `${sandboxId}: ${result.reason}`;
      // The settle resumed boxes to look inside; they go back to sleep.
      for (const id of resumed) await deps.pause(id).catch(() => false);
      return outcome;
    }
  }
  // Someone came back while we were settling: keep everything awake as is.
  const after = (await deps.getActivity([sessionKey])).get(sessionKey);
  if ((after?.lastActivityAt?.getTime() ?? 0) > candidate.lastUse) {
    outcome.reason = "used during the settle";
    return outcome;
  }
  for (const sandboxId of candidate.sandboxIds) {
    try {
      await deps.kill(sandboxId);
    } catch (error) {
      outcome.killFailures.push(`${sandboxId}: ${message(error)}`);
    }
  }
  try {
    await deps.forget(sessionKey);
  } catch (error) {
    outcome.killFailures.push(`forget: ${message(error)}`);
  }
  outcome.action = "deleted";
  return outcome;
}

/** Plan and reap in one go (the Inngest function splits these into steps). */
export async function reapPausedBoxes(
  deps: ReapDeps,
  config: BoxIdleConfig = boxIdleConfig(),
): Promise<{ plan: ReapPlan; outcomes: ReapOutcome[] }> {
  const plan = await planReap(deps, config);
  const outcomes: ReapOutcome[] = [];
  for (const candidate of plan.due) {
    outcomes.push(await reapSession(deps, candidate));
  }
  return { plan, outcomes };
}

// --------------------------------------------------------------------------
// Real dependencies (E2B + the box's git)
// --------------------------------------------------------------------------

/**
 * Work that must not be paused under itself. Prints `busy <what>` or nothing.
 *
 * - An unfinished `mako workflow run` (workflows/sandbox.ts writes .pid and,
 *   at the end, .exit).
 * - A terminal whose foreground process group is something other than a
 *   shell (ps `+` flag on a tty): a build, a test run, a REPL. Mako's own
 *   dev-server ptys (`mako-dev-<slug>`) are not terminals someone is using
 *   and are left out, or every box with a preview would never sleep.
 */
export const RUNNING_WORK_PROBE = [
  `for p in /tmp/mako-workflow-runs/*.pid; do [ -e "$p" ] || continue; b="\${p%.pid}"; [ -e "$b.exit" ] && continue; kill -0 "$(cat "$p")" 2>/dev/null && { echo "busy workflow run"; exit 0; }; done`,
  `ps -eo stat=,tty=,comm=,args= 2>/dev/null | awk '` +
    `$2=="?" {next} ` +
    `{ n++; st[n]=$1; tt[n]=$2; cm[n]=$3; if (index($0,"mako-dev-")>0) dev[$2]=1 } ` +
    `END { for (i=1;i<=n;i++) { if (tt[i] in dev) continue; if (st[i] !~ /\\+/) continue; ` +
    `if (cm[i] ~ /^-?(bash|sh|zsh|dash|fish)$|^tmux|^dtach$|^script$|^login$|^ps$|^awk$/) continue; ` +
    `print "busy terminal command " cm[i]; exit } }'`,
  "true",
].join("\n");

export function parseRunningWork(stdout: string): string | null {
  const line = stdout.split("\n").find(l => l.startsWith("busy "));
  return line ? line.slice(5).trim() : null;
}

async function runningWork(box: AppBoxInfo): Promise<string | null> {
  const run = await openAppBoxById(box.sandboxId);
  const result = await run(RUNNING_WORK_PROBE, { timeoutMs: 15_000 });
  return parseRunningWork(result.stdout);
}

async function announceAsleep(sessionKey: string): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  noteSessionPaused(sessionKey);
  if (parts) await markBoxOffline(parts.workspaceId, parts.userId);
}

const POLICY_COLLECTION = "apps_box_policy";
const TRACKING_DOC = "activity-tracking";

/** First call records "now" as the start of tracking; later calls read it. */
async function ensureTrackingSince(): Promise<Date> {
  const col = mongoose.connection.collection<{ _id: string; since: Date }>(
    POLICY_COLLECTION,
  );
  await col.updateOne(
    { _id: TRACKING_DOC },
    { $setOnInsert: { since: new Date() } },
    { upsert: true },
  );
  const doc = await col.findOne({ _id: TRACKING_DOC });
  return doc?.since ?? new Date();
}

async function readTrackingSince(): Promise<Date | null> {
  const doc = await mongoose.connection
    .collection<{ _id: string; since: Date }>(POLICY_COLLECTION)
    .findOne({ _id: TRACKING_DOC });
  return doc?.since ?? null;
}

/** Fresh git credential + origin, written in the box (configureBoxRemote's). */
function remoteScript(input: { workspaceId: string; token: string }): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const credential = `${BOX_ROOT}/.git/mako-git-token`;
  const helper = `!f() { printf 'username=mako\\npassword=%s\\n' "$(cat ${credential})"; }; f`;
  return [
    `cd ${q(BOX_ROOT)}`,
    `(umask 077 && printf '%s' ${q(input.token)} > ${q(credential)})`,
    `git config --replace-all credential.helper ''`,
    `git config --add credential.helper ${q(helper)}`,
    `{ git remote set-url origin ${q(appsGitOriginUrl(input.workspaceId))} || git remote add origin ${q(appsGitOriginUrl(input.workspaceId))}; }`,
  ].join(" && ");
}

async function settleBox(
  sessionKey: string,
  sandboxId: string,
): Promise<RescueResult> {
  const parts = parseSessionKey(sessionKey);
  if (!parts || !isUserActor(parts.userId)) {
    return {
      status: "manual",
      reason: "not a person's session",
      excluded: [],
      ignored: [],
    };
  }
  const run = await openAppBoxById(sandboxId);
  const author = await resolveActorIdentity(parts.userId);
  return rescueCommit({
    run,
    root: BOX_ROOT,
    userId: parts.userId,
    now: new Date(),
    author,
    prepareRemote: async () => {
      const token = mintGitToken({
        workspaceId: parts.workspaceId,
        userId: parts.userId,
        email: author?.email,
      });
      const result = await run(
        remoteScript({ workspaceId: parts.workspaceId, token }),
        {
          timeoutMs: 60_000,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error("could not refresh the box's git credential");
      }
    },
  });
}

async function forgetSession(sessionKey: string): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  forgetBoxCaches(sessionKey);
  forgetTerminalCaches(sessionKey);
  if (parts) await markBoxOffline(parts.workspaceId, parts.userId);
}

export function realSweepDeps(): SweepDeps {
  return {
    listBoxes: () => listAppBoxes(["running", "paused"]),
    getActivity: getBoxActivity,
    trackingSince: ensureTrackingSince,
    runningWork,
    announceAsleep,
    pause: pauseAppBox,
    now: Date.now,
  };
}

export function realReapDeps(): ReapDeps {
  return {
    listBoxes: () => listAppBoxes(["running", "paused"]),
    getActivity: getBoxActivity,
    trackingSince: readTrackingSince,
    settle: settleBox,
    pause: pauseAppBox,
    kill: killAppBox,
    forget: forgetSession,
    now: Date.now,
  };
}

/** The sweeps only mean something against E2B with a key. */
export function boxIdleSweepAvailable(): boolean {
  return getSandboxProvider().id === "e2b" && !!process.env.E2B_API_KEY;
}

/** Structured logs: one line per workspace plus a total. */
export function logBoxUsage(usage: WorkspaceBoxUsage[]): void {
  for (const row of usage) {
    logger.info("Apps box usage", { ...row });
  }
  logger.info("Apps box usage total", {
    workspaces: usage.length,
    running: usage.reduce((n, r) => n + r.running, 0),
    paused: usage.reduce((n, r) => n + r.paused, 0),
    boxSeconds: usage.reduce((n, r) => n + r.boxSeconds, 0),
    vcpuSeconds: usage.reduce((n, r) => n + r.vcpuSeconds, 0),
  });
}
