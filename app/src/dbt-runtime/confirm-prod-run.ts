import { useCallback } from "react";
import { useConfirm } from "../components/ConfirmDialog";

/**
 * The one "run against prod?" gate. The dbt console and the file editor both
 * ask it before any command targets the prod environment; `command` is the
 * full string the user is about to run (e.g. `dbt build --select foo+`).
 */
export function useConfirmProdRun(): (command: string) => Promise<boolean> {
  const confirm = useConfirm();
  return useCallback(
    (command: string) =>
      confirm({
        title: `Run "${command}" against the prod environment?`,
        confirmLabel: "Run against prod",
        destructive: true,
      }),
    [confirm],
  );
}
