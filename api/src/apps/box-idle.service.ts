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
import { AppWorktree } from "../database/workspace-schema";
import {
  getBoxActivity,
  lastBoxResume,
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
import { isPersonActorId } from "./worktree/worktrees";

const logger = loggers.api("apps-box-idle");

/** How often the pause sweep runs; also the box-seconds each tick bills. */
export const IDLE_SWEEP_INTERVAL_SECONDS = 120;

/** Where the working copy lives in an app box (e2b-provider REMOTE_ROOT). */
const BOX_ROOT = "/home/user/app";

export interface BoxIdleConfig {
  /** Pause sweep. Off only with `APPS_BOX_IDLE_SWEEP=off`. */
  enabled: boolean;
  /** Pause a running box this long after its last real use. */
  idleMs: number;
  /** Delete a paused session this long after its last real use. */
  pausedRetentionMs: number;
  /** At most this many sessions deleted per hourly run. */
  reapBatch: number;
  /**
   * Running work found by the probe (a terminal command, a workflow run)
   * keeps a box awake at most this long after its last real use. `vim`,
   * `less`, `tail -f` or a REPL left open would otherwise hold it forever.
   */
  maxHoldMs: number;
  /** Reaper: off, dryrun (settle and log, kill nothing) or on. */
  reaperMode: "off" | "dryrun" | "on";
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
 *   APPS_BOX_MAX_HOLD_MINUTES       default 120 (cap on probe-found work)
 *   APPS_BOX_REAPER=dryrun          plans every due session and logs it;
 *                                   resumes, settles and pushes nothing
 *   APPS_BOX_REAPER=on              enables deletion (off by default)
 */
export function boxIdleConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoxIdleConfig {
  return {
    enabled: env.APPS_BOX_IDLE_SWEEP !== "off",
    reaperMode:
      env.APPS_BOX_REAPER === "on"
        ? "on"
        : env.APPS_BOX_REAPER === "dryrun"
          ? "dryrun"
          : "off",
    maxHoldMs: positive(env.APPS_BOX_MAX_HOLD_MINUTES, 120) * 60_000,
    idleMs: positive(env.APPS_BOX_IDLE_MINUTES, 10) * 60_000,
    pausedRetentionMs:
      positive(env.APPS_BOX_PAUSED_RETENTION_DAYS, 14) * 24 * 3_600_000,
    reapBatch: Math.floor(positive(env.APPS_BOX_REAP_BATCH, 10)),
  };
}

/**
 * A person's own session box: `<ws>:<userId>` where userId is a real user id
 * (15-char, or legacy 24-hex). Not publish, not api-key.
 */
export function isPersonSession(sessionKey: string): boolean {
  const parts = parseSessionKey(sessionKey);
  return !!parts && isPersonActorId(parts.userId);
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
  /** Idle pauses so far and any safety-valve hold (see SAFETY_VALVE_*). */
  pauseHistory(sessionKey: string): Promise<PauseHistory>;
  recordPause(sessionKey: string, at: Date): Promise<void>;
  holdPausing(sessionKey: string, until: Date): Promise<void>;
  /** Who last connected to (and so maybe resumed) this session's box. */
  lastResumeCaller(sessionKey: string): Promise<string | null>;
  now(): number;
}

export interface PauseHistory {
  pausedAt: Date[];
  holdUntil: Date | null;
  /** When the hold was set; real use after this lifts it. */
  holdSetAt?: Date | null;
}

/**
 * Safety valve: more than this many idle pauses of one session within the
 * window, with no real activity in between, means something resumes the
 * box without being use. The sweep then stops pausing that session for the
 * hold and warns with the last resume caller, instead of churning the box.
 */
export const SAFETY_VALVE_PAUSES = 3;
export const SAFETY_VALVE_WINDOW_MS = 30 * 60_000;

export interface SweepResult {
  running: number;
  paused: number;
  pausedNow: Array<{
    sessionKey: string;
    sandboxId: string;
    idleMinutes: number;
    note?: string;
  }>;
  kept: Array<{ sessionKey: string; reason: string }>;
  /** Running sessions the sweep did not act on, and why (logged one each). */
  skipped: Array<{ sessionKey: string; reason: string }>;
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
    skipped: [],
    usage,
  };
  for (const key of new Set(running.map(b => b.sessionKey))) {
    if (!isPersonSession(key)) {
      const actor = parseSessionKey(key)?.userId ?? "unparsed";
      result.skipped.push({
        sessionKey: key,
        reason: `not a person session (actor ${actor})`,
      });
    }
  }
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
    const deadline = idleDeadline(act, since, config.idleMs);
    if (now < deadline) {
      result.skipped.push({
        sessionKey,
        reason: `not idle yet: due in ${Math.ceil((deadline - now) / 60_000)} min`,
      });
      continue;
    }

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
      if (now - lastUseOf(act, since) < config.maxHoldMs) {
        result.kept.push({ sessionKey, reason: busy });
        continue;
      }
      // Past the cap: an editor or a `tail -f` left open is not use.
    }
    const note = busy
      ? `${busy} ignored: no real use for ${Math.round(config.maxHoldMs / 60_000)} min`
      : undefined;

    // Re-read just this session: the probe took seconds, and someone may
    // have typed or saved meanwhile.
    const fresh = (await deps.getActivity([sessionKey])).get(sessionKey);
    if (deps.now() < idleDeadline(fresh, since, config.idleMs)) {
      result.kept.push({ sessionKey, reason: "used during the sweep" });
      continue;
    }

    // Safety valve: a session paused again and again with no real use in
    // between is being resumed by something that is not use. Stop feeding
    // the loop, and name the last resume caller so it can be fixed.
    let history: PauseHistory;
    try {
      history = await deps.pauseHistory(sessionKey);
    } catch (error) {
      // One session's lookup failing must not end the whole tick.
      result.kept.push({
        sessionKey,
        reason: `pause history unavailable: ${message(error)}`,
      });
      continue;
    }
    const lastUse = fresh?.lastActivityAt?.getTime() ?? 0;
    // A hold lasts until it expires, or until real use after it was set:
    // someone came back, so the box is judged afresh by the idle clock.
    const holdLive =
      !!history.holdUntil &&
      history.holdUntil.getTime() > now &&
      !(history.holdSetAt && lastUse > history.holdSetAt.getTime());
    if (holdLive && history.holdUntil) {
      result.kept.push({
        sessionKey,
        reason: `safety valve: pausing held until ${history.holdUntil.toISOString()}`,
      });
      continue;
    }
    const recent = history.pausedAt
      .map(d => d.getTime())
      .filter(t => now - t < SAFETY_VALVE_WINDOW_MS && t > lastUse);
    if (recent.length >= SAFETY_VALVE_PAUSES) {
      const caller = await deps.lastResumeCaller(sessionKey).catch(() => null);
      logger.warn("Apps box resumed without use; holding idle pauses", {
        sessionKey,
        pausesInWindow: recent.length,
        windowMinutes: SAFETY_VALVE_WINDOW_MS / 60_000,
        lastResumeCaller: caller ?? "unknown",
      });
      await deps
        .holdPausing(sessionKey, new Date(now + SAFETY_VALVE_WINDOW_MS))
        .catch(error =>
          logger.warn("Could not store the safety-valve hold", {
            sessionKey,
            error: message(error),
          }),
        );
      result.kept.push({
        sessionKey,
        reason: `safety valve: ${recent.length} pauses in 30 min without use; last resume by ${caller ?? "unknown"}`,
      });
      continue;
    }

    // Offline first, pause second. Pausing drops every pty, and a terminal
    // that sees its socket close while the box still reads "online"
    // reconnects within a second through ensureBox, which resumes the box
    // that was just paused. Announced first, it shows "off" and waits.
    await deps.announceAsleep(sessionKey).catch(() => undefined);
    const idleMinutes = Math.round((now - lastUseOf(fresh, since)) / 60_000);
    let pausedAny = false;
    for (const box of list) {
      try {
        if (!(await deps.pause(box.sandboxId))) {
          // E2B said it was not running (already paused): nothing happened.
          continue;
        }
        pausedAny = true;
        result.pausedNow.push({
          sessionKey,
          sandboxId: box.sandboxId,
          idleMinutes,
          ...(note ? { note } : {}),
        });
      } catch (error) {
        result.kept.push({
          sessionKey,
          reason: `pause failed: ${message(error)}`,
        });
      }
    }
    // Only a pause that happened counts toward the safety valve: failed
    // pauses must not read as "resumed without use".
    if (pausedAny) {
      await deps.recordPause(sessionKey, new Date(now)).catch(() => undefined);
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
  options: { all?: boolean } = {},
): Promise<ReapPlan> {
  const now = deps.now();
  const since = await deps.trackingSince();
  const sessions = groupBySession(await deps.listBoxes());
  const plan: ReapPlan = { due: [], skipped: [] };
  const people = [...sessions.keys()].filter(isPersonSession);
  for (const key of sessions.keys()) {
    if (!isPersonSession(key)) {
      plan.skipped.push({
        sessionKey: key,
        reason: `not a person session (actor ${parseSessionKey(key)?.userId ?? "unparsed"})`,
      });
    }
  }
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
  if (!options.all) plan.due = plan.due.slice(0, config.reapBatch);
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

/**
 * Plan and reap in one go (the Inngest function splits these into steps).
 *
 * Dry run plans EVERY due session and touches none: no resume, no settle,
 * no push. A settling dry run would wake the same oldest sessions every
 * hour and push a new rescue branch each time.
 */
export async function reapPausedBoxes(
  deps: ReapDeps,
  config: BoxIdleConfig = boxIdleConfig(),
): Promise<{ plan: ReapPlan; outcomes: ReapOutcome[] }> {
  if (config.reaperMode === "dryrun") {
    return { plan: await planReap(deps, config, { all: true }), outcomes: [] };
  }
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

/**
 * A fresh git credential, written in the box (configureBoxRemote's helper).
 * The origin URL is NOT touched: rescueCommit has already checked it is this
 * workspace's endpoint, and rewriting it would defeat that check.
 */
function remoteScript(input: { token: string }): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const credential = `${BOX_ROOT}/.git/mako-git-token`;
  const helper = `!f() { printf 'username=mako\\npassword=%s\\n' "$(cat ${credential})"; }; f`;
  return [
    `cd ${q(BOX_ROOT)}`,
    `(umask 077 && printf '%s' ${q(input.token)} > ${q(credential)})`,
    `git config --replace-all credential.helper ''`,
    `git config --add credential.helper ${q(helper)}`,
  ].join(" && ");
}

async function settleBox(
  sessionKey: string,
  sandboxId: string,
): Promise<RescueResult> {
  const parts = parseSessionKey(sessionKey);
  if (!parts || !isPersonActorId(parts.userId)) {
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
    expectedOrigin: appsGitOriginUrl(parts.workspaceId),
    prepareRemote: async () => {
      const token = mintGitToken({
        workspaceId: parts.workspaceId,
        userId: parts.userId,
        email: author?.email,
      });
      const result = await run(remoteScript({ token }), {
        timeoutMs: 60_000,
      });
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

function worktreeFilter(sessionKey: string) {
  const parts = parseSessionKey(sessionKey);
  return parts
    ? {
        workspaceId: new mongoose.Types.ObjectId(parts.workspaceId),
        userId: parts.userId,
      }
    : null;
}

async function pauseHistory(sessionKey: string): Promise<PauseHistory> {
  const filter = worktreeFilter(sessionKey);
  if (!filter) return { pausedAt: [], holdUntil: null };
  const doc = await AppWorktree.findOne(filter, {
    idlePausedAt: 1,
    idlePauseHoldUntil: 1,
    idlePauseHoldSetAt: 1,
  }).lean();
  return {
    pausedAt: doc?.idlePausedAt ?? [],
    holdUntil: doc?.idlePauseHoldUntil ?? null,
    holdSetAt: doc?.idlePauseHoldSetAt ?? null,
  };
}

async function recordPause(sessionKey: string, at: Date): Promise<void> {
  const filter = worktreeFilter(sessionKey);
  if (!filter) return;
  await AppWorktree.updateOne(
    filter,
    { $push: { idlePausedAt: { $each: [at], $slice: -5 } } },
    { timestamps: false },
  );
}

async function holdPausing(sessionKey: string, until: Date): Promise<void> {
  const filter = worktreeFilter(sessionKey);
  if (!filter) return;
  await AppWorktree.updateOne(
    filter,
    { $set: { idlePauseHoldUntil: until, idlePauseHoldSetAt: new Date() } },
    { timestamps: false },
  );
}

export function realSweepDeps(): SweepDeps {
  return {
    listBoxes: () => listAppBoxes(["running", "paused"]),
    getActivity: getBoxActivity,
    trackingSince: ensureTrackingSince,
    runningWork,
    announceAsleep,
    pause: pauseAppBox,
    pauseHistory,
    recordPause,
    holdPausing,
    lastResumeCaller: lastBoxResume,
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
