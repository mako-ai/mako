import { assign, createMachine } from "xstate";
import type { SyncState } from "../../database/workspace-schema";

export type CdcSyncEventType =
  | "START_BACKFILL"
  | "BACKFILL_COMPLETE"
  | "LAG_CLEARED"
  | "LAG_SPIKE"
  | "PAUSE"
  | "RESUME"
  | "FAIL"
  | "RECOVER";

export type CdcMachineEvent =
  | { type: "START_BACKFILL"; reason?: string }
  | { type: "BACKFILL_COMPLETE"; reason?: string }
  | { type: "LAG_CLEARED"; reason?: string }
  | { type: "LAG_SPIKE"; reason?: string }
  | { type: "PAUSE"; reason?: string }
  | { type: "RESUME"; reason?: string }
  | {
      type: "FAIL";
      reason?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "RECOVER"; reason?: string };

export interface CdcMachineContext {
  hasActiveRunLock: boolean;
  backfillCursorExhausted: boolean;
  backlogCount: number;
  lagSeconds: number | null;
  lagThresholdSeconds: number;
  lastEvent?: string;
  lastReason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export const CDC_LEGAL_TRANSITIONS: Record<
  SyncState,
  Partial<Record<CdcSyncEventType, SyncState>>
> = {
  idle: {
    START_BACKFILL: "backfill",
    PAUSE: "paused",
  },
  backfill: {
    BACKFILL_COMPLETE: "catchup",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  catchup: {
    LAG_CLEARED: "live",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  live: {
    LAG_SPIKE: "catchup",
    PAUSE: "paused",
    FAIL: "degraded",
  },
  paused: {
    RESUME: "catchup",
    FAIL: "degraded",
  },
  degraded: {
    RECOVER: "catchup",
  },
};

export function resolveCdcTransition(
  fromState: SyncState,
  eventType: CdcSyncEventType,
): SyncState | null {
  return CDC_LEGAL_TRANSITIONS[fromState]?.[eventType] || null;
}

export function passesTransitionGuard(
  event: CdcMachineEvent,
  context: Partial<CdcMachineContext> = {},
): boolean {
  if (event.type === "START_BACKFILL") {
    return context.hasActiveRunLock !== true;
  }

  if (event.type === "BACKFILL_COMPLETE") {
    return context.backfillCursorExhausted === true;
  }

  if (event.type === "LAG_CLEARED") {
    const backlogCount = context.backlogCount ?? 0;
    const lagSeconds = context.lagSeconds ?? null;
    const lagThresholdSeconds = context.lagThresholdSeconds ?? 60;
    return (
      backlogCount === 0 &&
      (lagSeconds === null || lagSeconds <= lagThresholdSeconds)
    );
  }

  return true;
}

export function createSyncMachine(input?: Partial<CdcMachineContext>) {
  return createMachine(
    {
      id: "cdc-flow-lifecycle",
      initial: "idle",
      context: {
        hasActiveRunLock: false,
        backfillCursorExhausted: false,
        backlogCount: 0,
        lagSeconds: null,
        lagThresholdSeconds: 60,
        ...input,
      } satisfies CdcMachineContext,
      states: {
        idle: {
          on: {
            START_BACKFILL: {
              target: "backfill",
              guard: "canStartBackfill",
              actions: "rememberEventMeta",
            },
            PAUSE: {
              target: "paused",
              actions: "rememberEventMeta",
            },
          },
        },
        backfill: {
          on: {
            BACKFILL_COMPLETE: {
              target: "catchup",
              guard: "isBackfillComplete",
              actions: "rememberEventMeta",
            },
            PAUSE: {
              target: "paused",
              actions: "rememberEventMeta",
            },
            FAIL: {
              target: "degraded",
              actions: "rememberEventMeta",
            },
          },
        },
        catchup: {
          on: {
            LAG_CLEARED: {
              target: "live",
              guard: "isLagCleared",
              actions: "rememberEventMeta",
            },
            PAUSE: {
              target: "paused",
              actions: "rememberEventMeta",
            },
            FAIL: {
              target: "degraded",
              actions: "rememberEventMeta",
            },
          },
        },
        live: {
          on: {
            LAG_SPIKE: {
              target: "catchup",
              actions: "rememberEventMeta",
            },
            PAUSE: {
              target: "paused",
              actions: "rememberEventMeta",
            },
            FAIL: {
              target: "degraded",
              actions: "rememberEventMeta",
            },
          },
        },
        paused: {
          on: {
            RESUME: {
              target: "catchup",
              actions: "rememberEventMeta",
            },
            FAIL: {
              target: "degraded",
              actions: "rememberEventMeta",
            },
          },
        },
        degraded: {
          on: {
            RECOVER: {
              target: "catchup",
              actions: "rememberEventMeta",
            },
          },
        },
      },
    },
    {
      guards: {
        canStartBackfill: ({ context }) => !context.hasActiveRunLock,
        isBackfillComplete: ({ context }) => context.backfillCursorExhausted,
        isLagCleared: ({ context }) =>
          context.backlogCount === 0 &&
          (context.lagSeconds === null ||
            context.lagSeconds <= context.lagThresholdSeconds),
      },
      actions: {
        rememberEventMeta: assign(({ context, event }) => {
          const typedEvent = event as CdcMachineEvent;
          return {
            ...context,
            lastEvent: typedEvent.type,
            lastReason: "reason" in typedEvent ? typedEvent.reason : undefined,
            lastErrorCode:
              "errorCode" in typedEvent ? typedEvent.errorCode : undefined,
            lastErrorMessage:
              "errorMessage" in typedEvent
                ? typedEvent.errorMessage
                : undefined,
          };
        }),
      },
    },
  );
}
