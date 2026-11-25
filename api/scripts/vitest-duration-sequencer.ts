/**
 * `vitest --shard I/N` by duration. Vitest's own sharding cuts the files,
 * sorted by a hash of their path, into N runs of equal count: the apps
 * config put its two 60 s files in one shard (117 s against 51 s).
 *
 * This puts files longest first onto the least-loaded shard, by the seconds
 * in vitest-test-durations.json (1 s for a file not listed there).
 * The split is deterministic, so the N shards together run every file
 * exactly once; a stale list only changes the balance. Same method as
 * run-tsx-tests.mjs --shard.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
// Types only: run-tsx-tests.mjs and test-coverage.test.ts import the vitest
// configs under tsx, where vitest/node does not load.
import type { TestSequencer, TestSpecification, Vitest } from "vitest/node";

const seconds: Record<string, number> = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "vitest-test-durations.json"),
    "utf8",
  ),
);

export class DurationSequencer implements TestSequencer {
  constructor(private readonly ctx: Vitest) {}

  private key(spec: TestSpecification) {
    return path
      .relative(this.ctx.config.root, spec.moduleId)
      .split(path.sep)
      .join("/");
  }

  private longestFirst(files: TestSpecification[]) {
    const cost = (spec: TestSpecification) => seconds[this.key(spec)] ?? 1;
    return [...files].sort(
      (a, b) => cost(b) - cost(a) || this.key(a).localeCompare(this.key(b)),
    );
  }

  shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    const loads = new Array<number>(count).fill(0);
    const mine: TestSpecification[] = [];
    for (const spec of this.longestFirst(files)) {
      const s = loads.indexOf(Math.min(...loads));
      loads[s] += seconds[this.key(spec)] ?? 1;
      if (s === index - 1) mine.push(spec);
    }
    return mine;
  }

  // Longest first, so a shard starts its slowest files first.
  sort(files: TestSpecification[]) {
    return this.longestFirst(files);
  }
}
