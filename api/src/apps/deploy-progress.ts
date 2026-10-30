/**
 * Where an app's in-flight deploy is.
 *
 * A deploy used to be visible only at its ends: `publishedSha` moved when it
 * landed and `lastDeployError` was set when it failed. In between,
 * app_publish_status said `upToDate: false` and nothing else, sometimes for
 * 20 minutes while parquet bindings were prepared. This records the stage on
 * the app row (`deployProgress`) so the status can say "bindings: 3 of 7,
 * preparing `pipeline`, for 12 minutes" and flag a stage that stopped moving.
 *
 * Writes are best effort: progress is diagnostics, and a failed write must
 * never fail the deploy it describes.
 */
import { Types } from "mongoose";
import {
  AppProject,
  type AppDeployStage,
  type IAppDeployProgress,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("apps-deploy-progress");

/**
 * A stage with no heartbeat for this long reads as stalled. Generous on
 * purpose: one binding can be a multi-minute warehouse query, and a busy
 * workspace queues deploys two at a time.
 */
export const DEPLOY_STALL_MS: Record<AppDeployStage, number> = {
  queued: 30 * 60_000,
  bindings: 20 * 60_000,
  build: 15 * 60_000,
  publishing: 10 * 60_000,
};

type ProjectRef = { _id: Types.ObjectId | string };

function idOf(project: ProjectRef | string): Types.ObjectId | null {
  const raw = typeof project === "string" ? project : project?._id;
  if (raw instanceof Types.ObjectId) return raw;
  const hex = raw === undefined || raw === null ? "" : String(raw);
  return /^[0-9a-f]{24}$/i.test(hex) ? new Types.ObjectId(hex) : null;
}

async function bestEffort(
  what: string,
  sha: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn("Could not record apps deploy progress", {
      what,
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A deploy of `sha` was requested. The newest request owns the row: the
 * deploy function is a per-app singleton that cancels older runs in favour
 * of the newest event, so its progress is the one worth showing.
 */
export function markDeployQueued(
  project: ProjectRef | string,
  sha: string,
  now: Date = new Date(),
): Promise<void> {
  const _id = idOf(project);
  if (!_id) return Promise.resolve();
  return bestEffort("queued", sha, () =>
    AppProject.updateOne(
      { _id },
      {
        $set: {
          deployProgress: {
            sha,
            stage: "queued",
            startedAt: now,
            stageStartedAt: now,
            updatedAt: now,
          } satisfies IAppDeployProgress,
        },
      },
    ),
  );
}

/**
 * The deploy of `sha` entered `stage`. Continues this sha's record when it
 * owns the row. Otherwise it takes the row only when nothing fresher holds
 * it: an older deploy still finishing a step after a newer push cancelled
 * it must not hide the newer one's progress.
 */
export function markDeployStage(
  project: ProjectRef | string,
  sha: string,
  stage: Exclude<AppDeployStage, "queued">,
  now: Date = new Date(),
): Promise<void> {
  const _id = idOf(project);
  if (!_id) return Promise.resolve();
  return bestEffort(stage, sha, async () => {
    const res = await AppProject.updateOne(
      { _id, "deployProgress.sha": sha },
      {
        $set: {
          "deployProgress.stage": stage,
          "deployProgress.stageStartedAt": now,
          "deployProgress.updatedAt": now,
        },
        $unset: { "deployProgress.bindings": 1 },
      },
    );
    if (res.matchedCount > 0) return;
    const staleBefore = new Date(
      now.getTime() - Math.min(...Object.values(DEPLOY_STALL_MS)),
    );
    await AppProject.updateOne(
      {
        _id,
        $or: [
          { deployProgress: { $exists: false } },
          { deployProgress: null },
          { "deployProgress.updatedAt": { $lt: staleBefore } },
        ],
      },
      {
        $set: {
          deployProgress: {
            sha,
            stage,
            startedAt: now,
            stageStartedAt: now,
            updatedAt: now,
          } satisfies IAppDeployProgress,
        },
      },
    );
  });
}

/** Binding preparation for `sha`: `prepared` of `total` ready. */
export function markBindingProgress(
  project: ProjectRef | string,
  sha: string,
  bindings: { total: number; prepared: number; current?: string },
  now: Date = new Date(),
): Promise<void> {
  const _id = idOf(project);
  if (!_id) return Promise.resolve();
  return bestEffort("bindings-progress", sha, () =>
    AppProject.updateOne(
      { _id, "deployProgress.sha": sha },
      {
        $set: {
          "deployProgress.bindings": bindings,
          "deployProgress.updatedAt": now,
        },
      },
    ),
  );
}

/** The lastDeployError stage for a deploy that died in `stage`. */
export function deployErrorStageFor(
  stage: AppDeployStage | undefined,
): "bindings" | "build" | "publish" {
  if (stage === "bindings") return "bindings";
  if (stage === "publishing") return "publish";
  return "build";
}

/** The deploy of `sha` ended (live, failed, or moot). */
export function clearDeployProgress(
  project: ProjectRef | string,
  sha: string,
): Promise<void> {
  const _id = idOf(project);
  if (!_id) return Promise.resolve();
  return bestEffort("clear", sha, () =>
    AppProject.updateOne(
      { _id, "deployProgress.sha": sha },
      { $unset: { deployProgress: 1 } },
    ),
  );
}

export interface DeployProgressView {
  sha: string;
  stage: AppDeployStage;
  startedAt: Date;
  stageStartedAt: Date;
  lastProgressAt: Date;
  /** Since the deploy was requested. */
  elapsedMs: number;
  /** Since the current stage began. */
  stageElapsedMs: number;
  bindings?: { total: number; prepared: number; current?: string };
  /** Present when the stage has had no heartbeat for DEPLOY_STALL_MS. */
  stalled?: { idleMs: number; thresholdMs: number; message: string };
  /** One line: "bindings: 3 of 7 prepared (preparing `pipeline`), 12 min". */
  summary: string;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "<1 min" : `${m} min`;
}

/**
 * What to show for a recorded deploy, or null when there is nothing in
 * flight: no record, or a leftover for the commit that is already live.
 */
export function describeDeployProgress(
  progress: IAppDeployProgress | null | undefined,
  publishedSha: string | null,
  now: Date = new Date(),
): DeployProgressView | null {
  if (!progress?.sha || progress.sha === publishedSha) return null;
  const startedAt = new Date(progress.startedAt);
  const stageStartedAt = new Date(progress.stageStartedAt);
  const lastProgressAt = new Date(progress.updatedAt);
  const idleMs = now.getTime() - lastProgressAt.getTime();
  const thresholdMs = DEPLOY_STALL_MS[progress.stage];
  const stageElapsedMs = now.getTime() - stageStartedAt.getTime();

  let detail: string = progress.stage;
  if (progress.stage === "bindings" && progress.bindings) {
    const { total, prepared, current } = progress.bindings;
    detail = `bindings: ${prepared} of ${total} prepared`;
    if (current) detail += ` (preparing \`${current}\`)`;
  }
  const view: DeployProgressView = {
    sha: progress.sha,
    stage: progress.stage,
    startedAt,
    stageStartedAt,
    lastProgressAt,
    elapsedMs: now.getTime() - startedAt.getTime(),
    stageElapsedMs,
    ...(progress.bindings ? { bindings: progress.bindings } : {}),
    summary: `${detail}, ${minutes(stageElapsedMs)} in this stage`,
  };
  if (idleMs > thresholdMs) {
    view.stalled = {
      idleMs,
      thresholdMs,
      message:
        `No progress in "${progress.stage}" for ${minutes(idleMs)} ` +
        `(threshold ${minutes(thresholdMs)}). The deploy worker may have ` +
        "stopped. Read app_build_log, then retry with app_publish.",
    };
  }
  return view;
}
