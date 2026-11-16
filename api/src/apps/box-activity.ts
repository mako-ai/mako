/**
 * Real use of an app box, as opposed to an open tab looking at it.
 *
 * E2B's idle timeout cannot tell the two apart. Every exec refreshes it, and
 * an open workbench execs on its own: the 15 s dev-server status poll, the
 * 30 s git-status and dev-servers polls, the boot-log tail, and a terminal
 * socket that reconnects (and so resumes the box) the moment a pause drops
 * it. A tab left open kept its box running for hours at 0–3% CPU.
 *
 * So the policy lives here instead. The places a person or an agent actually
 * does something record it; polls never do. The idle sweep
 * (box-idle.service.ts) pauses a box N minutes past its last real use.
 *
 * The record is two fields on the actor's AppWorktree row (one row per
 * sandbox), so every API instance and the Inngest sweep read the same
 * truth. Writes are throttled per process: a burst of agent commands is one
 * write, not fifty.
 */
import { Types } from "mongoose";
import { AppWorktree } from "../database/workspace-schema";
import { loggers } from "../logging";
import { BoundedMap } from "../utils/bounded-map";

const logger = loggers.api("apps-box-activity");

/** What counted as use. Logged, so a box that never sleeps can be explained. */
export type BoxActivityKind =
  | "edit"
  | "commit"
  | "agent-exec"
  | "preview"
  | "terminal-input"
  | "workflow-run";

/** One write per session per this window, unless the hold moves later. */
const WRITE_THROTTLE_MS = 30_000;

const lastWrite = new BoundedMap<string, { at: number; until: number }>({
  maxEntries: 5_000,
});

/** `<workspaceId>:<userId>` → its parts, or null for a malformed key. */
export function parseSessionKey(
  sessionKey: string,
): { workspaceId: string; userId: string } | null {
  const at = sessionKey.indexOf(":");
  if (at <= 0 || at === sessionKey.length - 1) return null;
  const workspaceId = sessionKey.slice(0, at);
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  return { workspaceId, userId: sessionKey.slice(at + 1) };
}

/**
 * Record real use of a box. Never throws and never blocks the caller for
 * long: losing one record costs at worst one early pause, which the next
 * action resumes from memory.
 *
 * `holdMs` keeps the box awake at least that long from now, for work that
 * outlives the call that started it (a long agent command).
 */
export async function recordBoxActivity(
  sessionKey: string,
  kind: BoxActivityKind,
  options: { holdMs?: number; now?: number } = {},
): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  if (!parts) return;
  const now = options.now ?? Date.now();
  const holdMs = Math.max(0, options.holdMs ?? 0);
  const until = holdMs > 0 ? now + holdMs : 0;
  const prev = lastWrite.get(sessionKey);
  // Inside the window, only a hold that reaches further is news.
  if (prev && now - prev.at < WRITE_THROTTLE_MS && until <= prev.until) {
    return;
  }
  lastWrite.set(sessionKey, {
    at: prev && now - prev.at < WRITE_THROTTLE_MS ? prev.at : now,
    until: Math.max(until, prev?.until ?? 0),
  });
  try {
    await AppWorktree.updateOne(
      {
        workspaceId: new Types.ObjectId(parts.workspaceId),
        userId: parts.userId,
      },
      {
        $max: {
          lastActivityAt: new Date(now),
          ...(holdMs > 0 ? { activeUntil: new Date(until) } : {}),
        },
      },
      // Activity is not an edit of the record: leave updatedAt alone.
      { timestamps: false },
    );
  } catch (error) {
    lastWrite.delete(sessionKey);
    logger.warn("Could not record box activity", {
      sessionKey,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Fire-and-forget form for hot paths. */
export function noteBoxActivity(
  sessionKey: string | null | undefined,
  kind: BoxActivityKind,
  options: { holdMs?: number } = {},
): void {
  if (!sessionKey) return;
  void recordBoxActivity(sessionKey, kind, options);
}

export interface BoxActivity {
  /** Whether an AppWorktree row exists for the key in THIS database. */
  known: boolean;
  lastActivityAt: Date | null;
  activeUntil: Date | null;
}

/** Activity for many sessions in one query. Unknown keys map to known=false. */
export async function getBoxActivity(
  sessionKeys: string[],
): Promise<Map<string, BoxActivity>> {
  const out = new Map<string, BoxActivity>();
  const or: Array<{ workspaceId: Types.ObjectId; userId: string }> = [];
  for (const key of new Set(sessionKeys)) {
    out.set(key, { known: false, lastActivityAt: null, activeUntil: null });
    const parts = parseSessionKey(key);
    if (parts) {
      or.push({
        workspaceId: new Types.ObjectId(parts.workspaceId),
        userId: parts.userId,
      });
    }
  }
  if (or.length === 0) return out;
  const docs = await AppWorktree.find(
    { $or: or },
    { workspaceId: 1, userId: 1, lastActivityAt: 1, activeUntil: 1 },
  ).lean();
  for (const doc of docs) {
    out.set(`${doc.workspaceId.toString()}:${doc.userId}`, {
      known: true,
      lastActivityAt: doc.lastActivityAt ?? null,
      activeUntil: doc.activeUntil ?? null,
    });
  }
  return out;
}

/** Test seam: forget the per-process write throttle. */
export function resetBoxActivityThrottleForTests(): void {
  lastWrite.clear();
}
