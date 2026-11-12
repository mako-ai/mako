// Owner: WP2 (notifications). Stub: the signature is the contract.

/**
 * Emit `flow.run.terminal` for a finished dbt job run so `dbt_job` and
 * `dbt_project` notification rules fan out. Call after the terminal status is
 * persisted. Reads the run itself; no-op for runs without a job, cancelled
 * runs and non-terminal runs. Never throws: failures are logged.
 */
export async function emitDbtRunTerminalEvent(runId: string): Promise<void> {
  void runId;
}
