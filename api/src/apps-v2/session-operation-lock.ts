import type { AppV2ExecutionPurpose } from "./providers/sandbox-provider";

export class AppV2KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export function appV2SessionOperationKey(input: {
  workspaceId: string;
  projectId: string;
  worktreeId: string;
  actorId: string;
  purpose: AppV2ExecutionPurpose;
}): string {
  return [
    input.workspaceId,
    input.projectId,
    input.worktreeId,
    input.actorId,
    input.purpose,
  ].join(":");
}

export const appV2SessionOperationMutex = new AppV2KeyedMutex();
