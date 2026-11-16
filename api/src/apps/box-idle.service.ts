/**
 * The app-box idle policy: pause after N idle minutes, delete after D paused
 * days, and report what the fleet costs.
 *
 * Why this exists (16 Nov 2026): 19 of 20 E2B slots were taken, 15 of them
 * by app boxes at 0–3% CPU, several up 40–57 minutes, and 89 paused boxes
 * sat on the account with a median start 23 days back. E2B's own idle
 * timeout never fired for an open tab, because the tab's polls exec into the
 * box and every exec refreshes the timeout (see box-activity.ts). Paused
 * boxes were never deleted by anyone.
 *
 * Two sweeps, both from Inngest crons (inngest/functions/apps-box-idle.ts):
 *
 * - sweepIdleBoxes, every 2 minutes: pause (with memory) every running app
 *   box whose last REAL use is N minutes old, unless a workflow run is still
 *   going inside it; log running/paused counts and box-seconds per
 *   workspace.
 * - reapPausedBoxes, hourly: delete sessions whose boxes have all been
 *   paused and unused for D days. Uncommitted work is committed to the
 *   person's session branch and pushed first; a box whose work cannot be
 *   made durable is left alone and the reason is logged.
 *
 * Both act only on sessions this database knows (an AppWorktree row). The
 * E2B account is shared with dev machines and previews, whose boxes belong
 * to other databases.
 */
import { loggers } from "../logging";
import {
  boxCommitAll,
  boxExec,
  boxRoot,
  boxStatus,
  configureBoxRemote,
  sh,
} from "./box";
import {
  getBoxActivity,
  parseSessionKey,
  type BoxActivity,
} from "./box-activity";
import { markBoxOffline } from "./box-state.service";
import { getSandboxProvider } from "./sandbox/provider";
import {
  listAppBoxes,
  pauseAppBox,
  type AppBoxInfo,
} from "./sandbox/e2b-fleet";
import { noteSessionPaused } from "./sandbox/e2b-provider";
import { forgetBoxCaches, resolveActorIdentity } from "./worktree/box-session";
import { withBoxPushLock } from "./worktree/files";
import { PUBLISH_ACTOR, isUserActor } from "./worktree/worktrees";
import { forgetTerminalCaches } from "./terminal/sessions";

const logger = loggers.api("apps-box-idle");

/** How often the pause sweep runs; also the box-seconds each tick bills. */
export const IDLE_SWEEP_INTERVAL_SECONDS = 120;

export interface BoxIdleConfig {
  /** Off switch: `APPS_BOX_IDLE_SWEEP=off`. */
  enabled: boolean;
  /** Pause a running box this long after its last real use. */
  idleMs: number;
  /** Delete a paused session this long after its last use. */
  pausedRetentionMs: number;
  /** At most this many deletions per hourly run (each resumes a box). */
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
 *   APPS_BOX_IDLE_SWEEP=off         disables both sweeps
 */
export function boxIdleConfig(
  env: NodeJS.ProcessEnv = process.env,
): BoxIdleConfig {
  return {
    enabled: env.APPS_BOX_IDLE_SWEEP !== "off",
    idleMs: positive(env.APPS_BOX_IDLE_MINUTES, 10) * 60_000,
    pausedRetentionMs:
      positive(env.APPS_BOX_PAUSED_RETENTION_DAYS, 14) * 24 * 3_600_000,
    reapBatch: Math.floor(positive(env.APPS_BOX_REAP_BATCH, 10)),
  };
}

/**
 * The last time this session was used, by the best evidence there is: the
 * activity record, or the box's start when the record is older or missing
 * (boxes started before activity was recorded, or by another instance's
 * create that has not been used since).
 */
export function lastUseOf(
  boxes: Array<Pick<AppBoxInfo, "startedAt">>,
  activity: BoxActivity | undefined,
): number {
  let last = activity?.lastActivityAt?.getTime() ?? 0;
  for (const box of boxes) last = Math.max(last, box.startedAt.getTime());
  return last;
}

/** When a running session may be paused: N idle minutes, or after its hold. */
export function idleDeadline(
  boxes: Array<Pick<AppBoxInfo, "startedAt">>,
  activity: BoxActivity | undefined,
  idleMs: number,
): number {
  return Math.max(
    lastUseOf(boxes, activity) + idleMs,
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
  /** A workflow run (or other declared long work) is still going inside. */
  hasRunningWork(sessionKey: string): Promise<boolean>;
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
  const usage = usageByWorkspace(boxes, now);
  const running = boxes.filter(b => b.state === "running");
  const result: SweepResult = {
    running: running.length,
    paused: boxes.length - running.length,
    pausedNow: [],
    kept: [],
    usage,
  };
  if (running.length === 0) return result;

  const sessions = groupBySession(running);
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
    const deadline = idleDeadline(list, act, config.idleMs);
    if (now < deadline) continue;
    try {
      if (await deps.hasRunningWork(sessionKey)) {
        result.kept.push({ sessionKey, reason: "workflow run in progress" });
        continue;
      }
    } catch (error) {
      // Cannot tell: keep it running this tick rather than pause a run.
      result.kept.push({
        sessionKey,
        reason: `work probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    // Offline first, pause second. Pausing drops every pty, and a terminal
    // that sees its socket close while the box still reads "online"
    // reconnects within a second — through ensureBox, which resumes the box
    // that was just paused. Announced first, the terminal shows "off" and
    // waits for a click instead.
    await deps.announceAsleep(sessionKey).catch(() => undefined);
    const idleMinutes = Math.round((now - lastUseOf(list, act)) / 60_000);
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
          reason: `pause failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// Paused-box reaper
// --------------------------------------------------------------------------

export type SettleOutcome =
  | { ok: true; committed?: string; note?: string }
  | { ok: false; reason: string };

export interface ReapDeps {
  listBoxes(): Promise<AppBoxInfo[]>;
  getActivity(sessionKeys: string[]): Promise<Map<string, BoxActivity>>;
  /**
   * Resume the box and make its work durable: commit uncommitted changes to
   * the session branch and push. ok=false means it could not be sure, and
   * the box must be kept.
   */
  settle(sessionKey: string): Promise<SettleOutcome>;
  /** Put a box back to sleep after a settle that failed. */
  pause(sandboxId: string): Promise<boolean>;
  /** Kill every box of the session and drop what the API believed about it. */
  destroy(sessionKey: string): Promise<void>;
  now(): number;
}

export interface ReapResult {
  /** Sessions past retention, before the batch cap. */
  due: number;
  deleted: Array<{
    sessionKey: string;
    boxes: number;
    committed?: string;
    idleDays: number;
  }>;
  skipped: Array<{ sessionKey: string; reason: string }>;
}

export async function reapPausedBoxes(
  deps: ReapDeps,
  config: BoxIdleConfig = boxIdleConfig(),
): Promise<ReapResult> {
  const now = deps.now();
  const boxes = await deps.listBoxes();
  const sessions = groupBySession(boxes);
  const result: ReapResult = { due: 0, deleted: [], skipped: [] };

  const candidates: Array<{
    sessionKey: string;
    boxes: AppBoxInfo[];
    lastUse: number;
  }> = [];
  const activity = await deps.getActivity([...sessions.keys()]);
  for (const [sessionKey, list] of sessions) {
    // A session with any box running is in use (or about to be paused by
    // the other sweep). Only all-paused sessions are candidates.
    if (list.some(b => b.state !== "paused")) continue;
    const act = activity.get(sessionKey);
    const lastUse = lastUseOf(list, act);
    if (now - lastUse < config.pausedRetentionMs) continue;
    if (!act?.known) {
      result.skipped.push({
        sessionKey,
        reason: "not a session of this database",
      });
      continue;
    }
    candidates.push({ sessionKey, boxes: list, lastUse });
  }
  result.due = candidates.length;
  // Oldest first, so a backlog drains in age order across runs.
  candidates.sort((a, b) => a.lastUse - b.lastUse);

  for (const { sessionKey, boxes: list, lastUse } of candidates.slice(
    0,
    config.reapBatch,
  )) {
    let outcome: SettleOutcome;
    try {
      outcome = await deps.settle(sessionKey);
    } catch (error) {
      outcome = {
        ok: false,
        reason: `settle failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!outcome.ok) {
      result.skipped.push({ sessionKey, reason: outcome.reason });
      // The settle resumed the box to look inside; it goes back to sleep.
      for (const box of list) {
        await deps.pause(box.sandboxId).catch(() => false);
      }
      continue;
    }
    // Used while we were settling (a person came back): keep it.
    const fresh = (await deps.getActivity([sessionKey])).get(sessionKey);
    if ((fresh?.lastActivityAt?.getTime() ?? 0) > lastUse) {
      result.skipped.push({ sessionKey, reason: "used during the sweep" });
      continue;
    }
    await deps.destroy(sessionKey);
    result.deleted.push({
      sessionKey,
      boxes: list.length,
      committed: outcome.committed,
      idleDays: Math.floor((now - lastUse) / 86_400_000),
    });
  }
  return result;
}

// --------------------------------------------------------------------------
// Real dependencies (E2B + the box's git)
// --------------------------------------------------------------------------

/** Unfinished `mako workflow run`s (workflows/sandbox.ts writes .pid / .exit). */
const RUNNING_WORK_PROBE =
  `for p in /tmp/mako-workflow-runs/*.pid; do [ -e "$p" ] || continue; ` +
  `b="\${p%.pid}"; [ -e "$b.exit" ] && continue; ` +
  `kill -0 "$(cat "$p")" 2>/dev/null && { echo busy; break; }; done; true`;

async function hasRunningWork(sessionKey: string): Promise<boolean> {
  const result = await getSandboxProvider().exec(
    { sessionKey },
    RUNNING_WORK_PROBE,
    { timeoutMs: 15_000 },
  );
  return result.stdout.includes("busy");
}

async function announceAsleep(sessionKey: string): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  noteSessionPaused(sessionKey);
  if (parts) await markBoxOffline(parts.workspaceId, parts.userId);
}

const AUTOSAVE_MESSAGE =
  "Autosave: uncommitted work from an idle sandbox before it was deleted";

/**
 * Make a paused box's work durable, or say why not. Resumes the box (every
 * exec connects), which the caller undoes with a pause on failure.
 */
export async function settleBoxForDelete(
  sessionKey: string,
): Promise<SettleOutcome> {
  const parts = parseSessionKey(sessionKey);
  if (!parts) return { ok: false, reason: "malformed session key" };
  const ctx = { sessionKey };
  const status = await boxStatus(ctx);
  const dirty = status.changes.length > 0 || status.ahead > 0;
  if (parts.userId === PUBLISH_ACTOR) {
    // The publish actor's box holds a trial merge rebuilt from the branch on
    // every publish (worktree/worktrees.ts PUBLISH_ACTOR): nothing in it is
    // a person's work, and committing it would ship an unbuilt candidate.
    // Every other actor, "api-key" included, holds real work and goes
    // through the commit and the checks below.
    return {
      ok: true,
      note: dirty ? "publish actor: derived working copy" : undefined,
    };
  }
  let committed: string | undefined;
  if (dirty) {
    if (status.branch === "HEAD") {
      return { ok: false, reason: "uncommitted work on a detached HEAD" };
    }
    // A non-user actor ("api-key") has no person to resolve; the box's own
    // configured identity commits for it.
    const author = isUserActor(parts.userId)
      ? await resolveActorIdentity(parts.userId)
      : undefined;
    // The box's git token may have expired while it slept.
    await configureBoxRemote({
      ctx,
      workspaceId: parts.workspaceId,
      userId: parts.userId,
      author,
    });
    const result = await withBoxPushLock(sessionKey, () =>
      boxCommitAll({
        ctx,
        message: AUTOSAVE_MESSAGE,
        author,
        committer: { name: "Mako", email: "agent@mako.ai" },
      }),
    );
    committed = result.commitOid;
  }
  // Trust, but verify: nothing left uncommitted, unpushed, stashed, or on a
  // local branch the server has never seen.
  const after = await boxStatus(ctx);
  if (after.changes.length > 0 || after.ahead > 0) {
    return {
      ok: false,
      reason: "work still not on the server after the autosave commit",
    };
  }
  const extra = await boxExec(
    ctx,
    `cd ${sh(boxRoot(ctx))} && ` +
      `echo "STASH=$(git stash list 2>/dev/null | head -1)"; ` +
      `echo "UNPUSHED=$(git log HEAD --branches --not --remotes --format=%H -1 2>/dev/null)"`,
    { timeoutMs: 30_000 },
  );
  if (/STASH=\S/.test(extra.stdout)) {
    return { ok: false, reason: "stash entries would be lost" };
  }
  if (/UNPUSHED=\S/.test(extra.stdout)) {
    return {
      ok: false,
      reason:
        "commits the server does not have (a local branch or a detached HEAD)",
    };
  }
  return { ok: true, committed };
}

async function destroySession(sessionKey: string): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  await getSandboxProvider().destroySession?.(sessionKey);
  forgetBoxCaches(sessionKey);
  forgetTerminalCaches(sessionKey);
  if (parts) await markBoxOffline(parts.workspaceId, parts.userId);
}

export function realSweepDeps(): SweepDeps {
  return {
    listBoxes: () => listAppBoxes(["running", "paused"]),
    getActivity: getBoxActivity,
    hasRunningWork,
    announceAsleep,
    pause: pauseAppBox,
    now: Date.now,
  };
}

export function realReapDeps(): ReapDeps {
  return {
    listBoxes: () => listAppBoxes(["running", "paused"]),
    getActivity: getBoxActivity,
    settle: settleBoxForDelete,
    pause: pauseAppBox,
    destroy: destroySession,
    now: Date.now,
  };
}

/** The sweep only means something against E2B with a key. */
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
