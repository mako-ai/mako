/**
 * In-process job registry: Claude ACP (via mako-desktop MCP) enqueues
 * Desktop-only tools; the Mako web/Desktop renderer claims and completes them.
 */

export type DesktopBridgeToolName = "run_app" | "get_preview_errors";

export interface DesktopBridgeJob {
  id: string;
  tool: DesktopBridgeToolName;
  arguments: Record<string, unknown>;
  createdAt: number;
}

interface PendingJob extends DesktopBridgeJob {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ClaimWaiter {
  resolve: (job: DesktopBridgeJob | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const JOB_TTL_MS = 25_000;
const DEFAULT_CLAIM_WAIT_MS = 20_000;

function newId(): string {
  return `dbj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

class DesktopBridgeRegistry {
  private queue: PendingJob[] = [];
  private claimed = new Map<string, PendingJob>();
  private waiters: ClaimWaiter[] = [];
  private lastClientSeenAt = 0;

  /** Desktop Chat calls this so tools can fail fast when nothing is listening. */
  touchClient(): void {
    this.lastClientSeenAt = Date.now();
  }

  hasRecentClient(maxAgeMs = 45_000): boolean {
    return Date.now() - this.lastClientSeenAt < maxAgeMs;
  }

  enqueue(
    tool: DesktopBridgeToolName,
    args: Record<string, unknown>,
    timeoutMs = JOB_TTL_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.hasRecentClient()) {
        reject(
          new Error(
            "Mako Desktop Chat is not connected to the Local Agent desktop bridge. Keep Chat open in Desktop and retry.",
          ),
        );
        return;
      }

      const id = newId();
      const job: PendingJob = {
        id,
        tool,
        arguments: args,
        createdAt: Date.now(),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failJob(
            id,
            new Error(
              `Desktop bridge timed out waiting for ${tool} (is Chat still open?)`,
            ),
          );
        }, timeoutMs),
      };

      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        this.claimed.set(id, job);
        waiter.resolve(publicJob(job));
        return;
      }
      this.queue.push(job);
    });
  }

  async claim(waitMs = DEFAULT_CLAIM_WAIT_MS): Promise<DesktopBridgeJob | null> {
    this.touchClient();
    const next = this.queue.shift();
    if (next) {
      this.claimed.set(next.id, next);
      return publicJob(next);
    }

    if (waitMs <= 0) return null;

    return new Promise(resolve => {
      const waiter: ClaimWaiter = {
        resolve: job => resolve(job),
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(null);
        }, waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  complete(id: string, result: unknown): boolean {
    const job = this.claimed.get(id) || this.queue.find(j => j.id === id);
    if (!job) return false;
    clearTimeout(job.timer);
    this.claimed.delete(id);
    this.queue = this.queue.filter(j => j.id !== id);
    job.resolve(result);
    return true;
  }

  fail(id: string, message: string): boolean {
    return this.failJob(id, new Error(message));
  }

  private failJob(id: string, error: Error): boolean {
    const claimed = this.claimed.get(id);
    const queued = this.queue.find(j => j.id === id);
    const job = claimed || queued;
    if (!job) return false;
    clearTimeout(job.timer);
    this.claimed.delete(id);
    this.queue = this.queue.filter(j => j.id !== id);
    job.reject(error);
    return true;
  }
}

function publicJob(job: PendingJob): DesktopBridgeJob {
  return {
    id: job.id,
    tool: job.tool,
    arguments: job.arguments,
    createdAt: job.createdAt,
  };
}

export const desktopBridgeRegistry = new DesktopBridgeRegistry();
