/**
 * Process tab-open helpers. Explorer rows, run links and deep links all open
 * tabs through these; dedupe is the store's focusOrOpenTab, like every kind.
 */
import { useConsoleStore } from "../store/consoleStore";

/** The process page: outline, tools, runs. */
export function focusProcessTab(processId: string, title: string): string {
  return useConsoleStore.getState().focusOrOpenTab(
    { kind: "process", metadata: { processId } },
    () => ({
      title,
      content: "",
      kind: "process",
      metadata: { processId },
    }),
    { replacePristine: false },
  ) as string;
}

/** One run's timeline. */
export function focusProcessRunTab(
  processId: string,
  runId: string,
  title: string,
): string {
  return useConsoleStore.getState().focusOrOpenTab(
    { kind: "process-run", metadata: { processId, runId } },
    () => ({
      title,
      content: "",
      kind: "process-run",
      metadata: { processId, runId },
    }),
    { replacePristine: false },
  ) as string;
}

/** Approvals and tasks across every process. */
export function focusProcessInboxTab(): string {
  return useConsoleStore.getState().focusOrOpenTab(
    { kind: "process-inbox" },
    () => ({
      title: "Inbox",
      content: "",
      kind: "process-inbox",
      metadata: {},
    }),
    { replacePristine: false, pin: true },
  ) as string;
}
