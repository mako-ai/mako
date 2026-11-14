/**
 * For tests that run lib/mako as a deployed step: what step.mjs does. A
 * request to Mako made while a workflow is named (globalThis.makoWorkflow,
 * as the step program sets it) and with the worker key goes out with a pass
 * for that workflow and the run of globalThis.makoRun instead, made here as
 * the dispatcher would get it from Mako (workflows/pass.ts). Without a run
 * there is no pass, and the request keeps the worker key.
 */
import { hashApiKey } from "../auth/api-key.middleware";
import { keyIdOf, mintPass } from "./pass";

type Store<T> = { getStore(): T | undefined } | undefined;

export function installPassFetch(options: {
  workerKey: string;
  workspaceId: () => string;
  makoOrigin: () => string;
}): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(href).origin;
    } catch {
      // Not an absolute URL.
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const g = globalThis as {
      makoWorkflow?: Store<unknown>;
      makoRun?: Store<{ runId?: string; step?: string }>;
    };
    const workflow = g.makoWorkflow?.getStore();
    const run = g.makoRun?.getStore();
    if (
      origin !== options.makoOrigin() ||
      headers.get("Authorization") !== `Bearer ${options.workerKey}` ||
      typeof workflow !== "string" ||
      !run?.runId
    ) {
      return realFetch(input, init);
    }
    const { token } = mintPass({
      workspaceId: options.workspaceId(),
      workflow,
      runId: run.runId,
      step: run.step,
      keyId: keyIdOf(hashApiKey(options.workerKey)),
    });
    headers.set("Authorization", `Bearer ${token}`);
    return realFetch(input, { ...init, headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}
