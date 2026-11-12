/**
 * The idle kernel pool scales down only when every kernel on every pod has
 * been idle past the TTL and no pod is new. Kubernetes and the gateways are
 * fakes.
 *
 * Run with: pnpm --filter api exec tsx src/services/kernel-provider/kernel-pool-reaper.test.ts
 */
import assert from "node:assert/strict";
import type { V1Pod } from "@kubernetes/client-node";

async function main() {
  process.env.KERNEL_SESSION_IDLE_MS = String(15 * 60_000);
  delete process.env.KERNEL_POOL_MIN_REPLICAS;
  const { keepReason, reapIdleKernelPool } =
    await import("./kernel-pool-reaper");
  const now = Date.parse("2026-11-11T12:00:00Z");
  const iso = (agoMin: number) => new Date(now - agoMin * 60_000).toISOString();
  const oldPod = { name: "p", startedAtMs: now - 60 * 60_000 };

  // --- keepReason -----------------------------------------------------------
  assert.equal(keepReason([], now), null);
  assert.equal(keepReason([{ ...oldPod, kernels: [] }], now), null);
  assert.equal(
    keepReason(
      [
        {
          ...oldPod,
          kernels: [{ last_activity: iso(30), execution_state: "idle" }],
        },
      ],
      now,
    ),
    null,
  );
  assert.match(
    keepReason([{ ...oldPod, kernels: [{ last_activity: iso(5) }] }], now) ??
      "",
    /used recently/,
  );
  assert.match(
    keepReason(
      [
        {
          ...oldPod,
          kernels: [{ last_activity: iso(60), execution_state: "busy" }],
        },
      ],
      now,
    ) ?? "",
    /busy/,
  );
  assert.match(
    keepReason([{ ...oldPod, kernels: null }], now) ?? "",
    /did not answer/,
  );
  assert.match(
    keepReason(
      [{ name: "new", startedAtMs: now - 60_000, kernels: [] }],
      now,
    ) ?? "",
    /started recently/,
  );
  assert.match(
    keepReason([{ ...oldPod, kernels: [{ last_activity: "?" }] }], now) ?? "",
    /used recently/,
  );

  // --- reapIdleKernelPool ---------------------------------------------------
  const pod = (
    name: string,
    ip: string | undefined,
    agoMin: number,
  ): V1Pod => ({
    metadata: { name },
    status: { podIP: ip, startTime: new Date(now - agoMin * 60_000) },
  });
  const run = async (
    replicas: number,
    pods: V1Pod[],
    kernels: Record<string, unknown>,
  ) => {
    const written: number[] = [];
    const result = await reapIdleKernelPool(
      {
        apps: {
          readNamespacedDeploymentScale: async () => ({ spec: { replicas } }),
          replaceNamespacedDeploymentScale: async (req: {
            body: { spec?: { replicas?: number } };
          }) => {
            written.push(req.body.spec?.replicas ?? -1);
            return req.body;
          },
        },
        core: { listNamespacedPod: async () => ({ items: pods }) },
      } as never,
      {
        nowMs: now,
        listKernels: async ip => (kernels[ip] ?? null) as never,
      },
    );
    return { result, written };
  };

  // Idle: scaled to 0.
  let out = await run(1, [pod("a", "10.0.0.1", 60)], {
    "10.0.0.1": [{ last_activity: iso(20), execution_state: "idle" }],
  });
  assert.deepEqual(out.result, { from: 1, to: 0 });
  assert.deepEqual(out.written, [0]);

  // One pod in use among several: kept, nothing written.
  out = await run(2, [pod("a", "10.0.0.1", 60), pod("b", "10.0.0.2", 60)], {
    "10.0.0.1": [],
    "10.0.0.2": [{ last_activity: iso(1) }],
  });
  assert.equal(out.result.to, 2);
  assert.ok(out.result.kept);
  assert.deepEqual(out.written, []);

  // A pod still starting (no IP): kept.
  out = await run(1, [pod("a", undefined, 1)], {});
  assert.match(out.result.kept ?? "", /started recently/);

  // A terminating pod is ignored.
  const leaving = pod("old", "10.0.0.9", 60);
  leaving.metadata!.deletionTimestamp = new Date(now);
  out = await run(1, [leaving], {});
  assert.deepEqual(out.written, [0]);

  // Already at the floor: nothing read, nothing written.
  out = await run(0, [], {});
  assert.deepEqual(out, { result: { from: 0, to: 0 }, written: [] });

  // A floor set by env is kept.
  process.env.KERNEL_POOL_MIN_REPLICAS = "1";
  out = await run(1, [pod("a", "10.0.0.1", 60)], { "10.0.0.1": [] });
  assert.deepEqual(out, { result: { from: 1, to: 1 }, written: [] });
  delete process.env.KERNEL_POOL_MIN_REPLICAS;

  console.log("kernel pool reaper tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
